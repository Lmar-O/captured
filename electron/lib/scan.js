'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { captureDate, groupLabel, groupKey } = require('./dates');

/** Containers a camera is likely to write. */
const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mts', '.m2ts', '.mxf',
  '.braw', '.r3d', '.insv', '.mkv', '.mpg', '.mpeg', '.3gp', '.wmv',
]);

/** Sidecars that ride along with a clip of the same basename. */
const SIDECAR_EXTS = new Set(['.xml', '.srt', '.thm', '.cpi', '.bim']);

/**
 * Suffixes a camera appends to a sidecar's basename.
 *
 * Sony writes C0001.MP4 alongside C0001M01.XML — the metadata file carries an
 * "M<nn>" tag the clip does not, so an exact basename match finds nothing on
 * the cards most likely to have XML at all.
 */
const SIDECAR_SUFFIX = /^(.+?)M\d{2}$/i;

/**
 * Proxy and helper files cameras drop next to the real clip. DJI writes an
 * .LRV low-res proxy for every .MP4; importing those doubles the file count
 * for no benefit, so they are skipped unless the user opts in.
 */
const PROXY_EXTS = new Set(['.lrv']);

/** Directories that are never worth walking on a card or a Mac volume. */
const SKIP_DIRS = new Set([
  '.spotlight-v100', '.fseventsd', '.trashes', '.temporaryitems',
  '.documentrevisions-v100', 'system volume information', '$recycle.bin',
  'lost.dir', '.ds_store',
]);

/**
 * Walk a source directory and return everything importable.
 *
 * `recursive` maps to the "Include subfolders" checkbox — cards keep clips
 * under DCIM/100MEDIA and similar, so it defaults on.
 */
async function scanSource(sourceDir, { recursive = true, includeProxies = false } = {}) {
  const videos = [];
  const sidecars = new Map(); // "dir\0basename" -> [{ ext, fullPath, size }]

  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!recursive) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (entry.name.startsWith('._')) continue;
        // Cards are shallow; the cap just stops a symlink loop on a volume.
        if (depth < 12) await walk(full, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (entry.name.startsWith('._') || entry.name.startsWith('.')) continue;

      // Cameras write MP4/XML in caps and the destination should read the
      // same way, so the original spelling is kept for naming and the
      // lowercased form is used only for matching.
      const rawExt = path.extname(entry.name);
      const ext = rawExt.toLowerCase();
      const base = path.basename(entry.name, rawExt);

      if (VIDEO_EXTS.has(ext) || (includeProxies && PROXY_EXTS.has(ext))) {
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        videos.push({ fullPath: full, name: entry.name, base, ext, rawExt, stat });
      } else if (SIDECAR_EXTS.has(ext)) {
        let size = 0;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          continue;
        }

        // Indexed under its own basename and, when the camera tagged it, under
        // the clip basename it belongs to, so the lookup below stays a single
        // exact hit either way.
        const lower = base.toLowerCase();
        const tagged = SIDECAR_SUFFIX.exec(lower);
        const bases = tagged ? [lower, tagged[1]] : [lower];
        const record = { ext, rawExt, fullPath: full, name: entry.name, size };

        for (const b of bases) {
          const key = `${dir}\0${b}`;
          if (!sidecars.has(key)) sidecars.set(key, []);
          sidecars.get(key).push(record);
        }
      }
    }
  }

  await walk(sourceDir, 0);

  const now = new Date();
  const files = videos.map((v) => {
    const date = captureDate(v.stat);
    const key = `${path.dirname(v.fullPath)}\0${v.base.toLowerCase()}`;
    const attached = sidecars.get(key) || [];

    return {
      id: crypto.createHash('sha1').update(v.fullPath).digest('hex').slice(0, 16),
      name: v.name,
      base: v.base,
      ext: v.rawExt,
      fullPath: v.fullPath,
      relPath: path.relative(sourceDir, v.fullPath),
      size: v.stat.size,
      mtimeMs: v.stat.mtimeMs,
      capturedAt: date.toISOString(),
      groupKey: groupKey(date),
      groupLabel: groupLabel(date, now),
      sidecars: attached.map((s) => ({
        name: s.name, fullPath: s.fullPath, size: s.size, ext: s.rawExt, kind: s.ext,
      })),
      hasXml: attached.some((s) => s.ext === '.xml'),
    };
  });

  // Newest group first; within a group, shot order.
  files.sort((a, b) => (a.groupKey === b.groupKey
    ? a.name.localeCompare(b.name, undefined, { numeric: true })
    : b.groupKey.localeCompare(a.groupKey)));

  return files;
}

/**
 * Flag files that already look present in the destination.
 *
 * The destination is laid out by the same date rules the import will use, so
 * this checks the exact folder each file would land in — a clip is only a
 * duplicate if a same-named file of the same size is already sitting where
 * this import would put it. Matching on name alone would false-positive
 * across shoots (cameras reuse DJI_0001.MP4 after a card format), and
 * hashing gigabytes of video to be sure would cost more than the copy.
 */
async function markDuplicates(files, targets) {
  const dirCache = new Map();

  for (const file of files) {
    const target = targets.get(file.id);
    if (!target) {
      file.duplicate = false;
      continue;
    }

    let listing = dirCache.get(target.dir);
    if (!listing) {
      listing = new Map();
      try {
        const entries = await fs.readdir(target.dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) listing.set(entry.name.toLowerCase(), entry.name);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      dirCache.set(target.dir, listing);
    }

    const existing = listing.get(target.name.toLowerCase());
    if (!existing) {
      file.duplicate = false;
      continue;
    }

    try {
      const stat = await fs.stat(path.join(target.dir, existing));
      file.duplicate = stat.size === file.size;
      file.duplicateReason = stat.size === file.size
        ? 'Already in destination'
        : undefined;
      if (!file.duplicate) {
        // Same name, different bytes — the import will disambiguate rather
        // than clobber, so surface it as a collision instead of a duplicate.
        file.nameCollision = true;
      }
    } catch {
      file.duplicate = false;
    }
  }

  return files;
}

module.exports = { scanSource, markDuplicates, VIDEO_EXTS, SIDECAR_EXTS };
