'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { dateSegments, resolveDatedDir } = require('./dates');

/**
 * Work out where every selected file lands, without touching the disk.
 *
 * Planning is separated from copying so the destination preview, the
 * duplicate badges and the import itself all agree on the same paths.
 *
 * Two flags separate the preview pass from the real one. `create` makes the
 * missing date folders. `resolveCollisions` lets a clip slide to `-1` when
 * its name is taken — which the real import needs, but the preview must not
 * do: a file whose name is already occupied is precisely what the duplicate
 * check is looking for, and renaming it first would hide every duplicate.
 */
async function planImport(files, settings, { create = false, resolveCollisions = create } = {}) {
  const {
    destination,
    organizeMode = 'date',
    dateFormat,
    renameEnabled = false,
    renameBase = '',
    includeXml = true,
  } = settings;

  const listingCache = new Map();
  const targets = new Map();
  const createdDirs = [];
  const base = renameBase.trim();
  const useRename = renameEnabled && base.length > 0;

  // Numbering runs across the whole selection in shot order so a renamed
  // import reads Japan_1, Japan_2, … regardless of which date folder each
  // clip ends up in.
  const ordered = [...files].sort((a, b) => (
    a.capturedAt === b.capturedAt
      ? a.name.localeCompare(b.name, undefined, { numeric: true })
      : a.capturedAt.localeCompare(b.capturedAt)
  ));

  // Reserve names per directory so two source files never plan onto one path.
  const claimed = new Map();

  for (const [index, file] of ordered.entries()) {
    let dir = destination;

    if (organizeMode === 'date') {
      const segments = dateSegments(new Date(file.capturedAt), dateFormat);
      const resolved = await resolveDatedDir(destination, segments, listingCache, { create });
      dir = resolved.dir;
      createdDirs.push(...resolved.created);
    }

    const stem = useRename ? `${base}_${index + 1}` : file.base;
    const name = resolveCollisions
      ? await claimName(dir, stem, file.ext, claimed)
      : `${stem}${file.ext}`;

    targets.set(file.id, {
      dir,
      name,
      stem: path.basename(name, path.extname(name)),
      fullPath: path.join(dir, name),
      sidecars: includeXml
        ? file.sidecars.map((s) => ({
            from: s.fullPath,
            to: path.join(dir, `${path.basename(name, path.extname(name))}${s.ext}`),
            size: s.size,
          }))
        : [],
    });
  }

  return { targets, createdDirs };
}

/**
 * Pick a filename that is free both on disk and within this plan.
 *
 * A camera that has been reformatted starts numbering at DJI_0001 again, so
 * an existing file of the same name may well be different footage. Rather
 * than overwrite it, the import parks the new clip beside it as `-1`, `-2`
 * and so on. Files the user chose to skip as duplicates never reach here.
 */
async function claimName(dir, stem, ext, claimed) {
  let set = claimed.get(dir);
  if (!set) {
    set = new Set();
    claimed.set(dir, set);
  }

  for (let n = 0; n < 10000; n += 1) {
    const candidate = n === 0 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    const key = candidate.toLowerCase();
    if (set.has(key)) continue;
    try {
      await fsp.access(path.join(dir, candidate));
      continue; // taken on disk
    } catch {
      set.add(key);
      return candidate;
    }
  }
  throw new Error(`Could not find a free filename for ${stem}${ext} in ${dir}`);
}

/**
 * Copy one file, reporting bytes as they land.
 *
 * Streaming rather than fs.copyFile so a 1 GB clip can move a progress bar;
 * the capture timestamp is restored afterwards so the date the footage was
 * shot survives the trip off the card.
 */
async function copyFile(from, to, { signal, onBytes } = {}) {
  const stat = await fsp.stat(from);
  const tmp = `${to}.captured-part`;

  try {
    const read = fs.createReadStream(from, { highWaterMark: 4 * 1024 * 1024 });
    const write = fs.createWriteStream(tmp);

    if (onBytes) read.on('data', (chunk) => onBytes(chunk.length));
    await pipeline(read, write, { signal });

    const copied = await fsp.stat(tmp);
    if (copied.size !== stat.size) {
      throw new Error(`Size mismatch after copy (${copied.size} of ${stat.size} bytes)`);
    }

    await fsp.rename(tmp, to);
    await fsp.utimes(to, stat.atime, stat.mtime).catch(() => {});
    return stat.size;
  } catch (err) {
    // Never leave a half-written clip looking like a finished one.
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Run the import.
 *
 * `onProgress` receives a running summary after every file and periodically
 * during large copies. Cancellation via `signal` stops before the next file
 * and discards the partial copy in flight.
 */
async function runImport(files, settings, { signal, onProgress } = {}) {
  const { targets, createdDirs } = await planImport(files, settings, { create: true });

  const totalBytes = files.reduce((sum, f) => {
    const t = targets.get(f.id);
    return sum + f.size + (t ? t.sidecars.reduce((s, x) => s + x.size, 0) : 0);
  }, 0);

  const result = {
    copied: [],
    failed: [],
    skipped: [],
    createdDirs,
    totalBytes,
    bytesDone: 0,
    startedAt: Date.now(),
  };

  let lastTick = 0;
  const tick = (force) => {
    const now = Date.now();
    if (!force && now - lastTick < 100) return;
    lastTick = now;
    onProgress?.({
      bytesDone: result.bytesDone,
      totalBytes,
      copiedCount: result.copied.length,
      failedCount: result.failed.length,
      totalCount: files.length,
      elapsedMs: now - result.startedAt,
      current: result.current,
    });
  };

  for (const file of files) {
    if (signal?.aborted) {
      result.cancelled = true;
      break;
    }

    const target = targets.get(file.id);
    if (!target) continue;

    result.current = { name: target.name, from: file.fullPath, to: target.fullPath };
    tick(true);

    try {
      await copyFile(file.fullPath, target.fullPath, {
        signal,
        onBytes: (n) => {
          result.bytesDone += n;
          tick(false);
        },
      });

      const sidecarsCopied = [];
      for (const sidecar of target.sidecars) {
        try {
          await copyFile(sidecar.from, sidecar.to, {
            signal,
            onBytes: (n) => {
              result.bytesDone += n;
              tick(false);
            },
          });
          sidecarsCopied.push(sidecar.to);
        } catch (err) {
          // A missing sidecar should not fail the clip it belongs to.
          result.failed.push({
            name: path.basename(sidecar.from),
            path: sidecar.from,
            error: err.message,
            sidecar: true,
          });
        }
      }

      result.copied.push({
        id: file.id,
        name: target.name,
        from: file.fullPath,
        to: target.fullPath,
        size: file.size,
        sidecars: sidecarsCopied,
      });
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) {
        result.cancelled = true;
        break;
      }
      result.failed.push({ id: file.id, name: file.name, path: file.fullPath, error: err.message });
    }

    tick(true);
  }

  result.current = null;
  result.finishedAt = Date.now();
  tick(true);
  return result;
}

/** Bytes free on the volume holding `dir`, for the pre-flight space check. */
async function freeSpace(dir) {
  try {
    const stat = await fsp.statfs(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

module.exports = { planImport, runImport, copyFile, freeSpace };
