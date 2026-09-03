'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Folder layouts offered in the Destination pane. The key is what gets
 * persisted in settings; `segments` turns a capture date into the path
 * components below the destination root.
 */
const DATE_FORMATS = {
  'YYYY-MM-DD': {
    label: '2026-09-03',
    segments: (d) => [`${yyyy(d)}-${mm(d)}-${dd(d)}`],
  },
  'YYYY/YYYY-MM-DD': {
    label: '2026/2026-09-03',
    segments: (d) => [yyyy(d), `${yyyy(d)}-${mm(d)}-${dd(d)}`],
  },
  'YYYY/MM/DD': {
    label: '2026/09/03',
    segments: (d) => [yyyy(d), mm(d), dd(d)],
  },
};

const DEFAULT_DATE_FORMAT = 'YYYY/YYYY-MM-DD';

const yyyy = (d) => String(d.getFullYear());
const mm = (d) => String(d.getMonth() + 1).padStart(2, '0');
const dd = (d) => String(d.getDate()).padStart(2, '0');

function dateSegments(date, format) {
  const spec = DATE_FORMATS[format] || DATE_FORMATS[DEFAULT_DATE_FORMAT];
  return spec.segments(date);
}

/**
 * Capture time for a file on the card.
 *
 * mtime is the stamp to trust: cameras set it to the moment the clip was
 * written, in the camera's own local time, which is exactly the day the user
 * means when they say "the Sep 3 footage". It also survives every sane copy.
 *
 * birthtime is only a fallback. It is unreliable in both directions — FAT32
 * cards and some readers report 0 or the mount time, while a metadata-
 * preserving copy carries the *original* file's birthtime, which can predate
 * the shoot by years. It is used only when mtime is missing or obviously
 * bogus.
 */
function captureDate(stat) {
  const valid = (ms) => Number.isFinite(ms) && ms > 86400000;

  if (valid(stat.mtimeMs)) return new Date(stat.mtimeMs);
  if (valid(stat.birthtimeMs)) return new Date(stat.birthtimeMs);
  return new Date();
}

/**
 * Resolve the dated folder for a capture date, reusing directories that are
 * already on disk and only creating the ones that are missing.
 *
 * Each segment is matched against the real directory listing rather than
 * probed with a stat, so an existing `2026` is reused with its own casing
 * instead of a second one being created next to it. macOS volumes are
 * normally case-insensitive but case-preserving, and an SD card workflow
 * spans many imports, so a plain mkdir would otherwise be able to leave
 * `2026` and `2026` as separate trees on a case-sensitive volume.
 *
 * `listingCache` memoises directory listings for the duration of one import
 * run; pass the same Map across calls to avoid re-reading parents per file.
 *
 * With `create: false` nothing is written — missing segments are appended as
 * literal names. That is what the destination preview and the duplicate check
 * use, so they report against the same folder the import will really use.
 *
 * Returns { dir, created } where `created` lists the absolute paths of
 * directories this call actually made.
 */
async function resolveDatedDir(root, segments, listingCache = new Map(), { create = true } = {}) {
  let current = root;
  const created = [];

  for (const segment of segments) {
    const existing = await findExistingChild(current, segment, listingCache);

    if (existing) {
      current = path.join(current, existing);
      continue;
    }

    const target = path.join(current, segment);

    if (!create) {
      // Nothing below a missing directory can exist either, so the rest of
      // the path is just the remaining segments joined on.
      current = target;
      continue;
    }
    try {
      await fs.mkdir(target);
      created.push(target);
      // Keep the cache honest so sibling files in the same run see this dir.
      const cached = listingCache.get(current);
      if (cached) cached.set(segment.toLowerCase(), segment);
    } catch (err) {
      // Another file in this run (or another process) won the race. Fine —
      // as long as what landed there is a directory.
      if (err.code !== 'EEXIST') throw err;
      listingCache.delete(current);
      const raced = await findExistingChild(current, segment, listingCache);
      if (!raced) throw err;
      current = path.join(current, raced);
      continue;
    }
    current = target;
  }

  return { dir: current, created };
}

/**
 * Find a child directory matching `name`, preferring an exact hit and
 * falling back to a case-insensitive one. Returns the on-disk name.
 */
async function findExistingChild(parent, name, listingCache) {
  let listing = listingCache.get(parent);

  if (!listing) {
    listing = new Map();
    try {
      const entries = await fs.readdir(parent, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          listing.set(entry.name.toLowerCase(), entry.name);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    listingCache.set(parent, listing);
  }

  // Exact match wins over a case-folded one on case-sensitive volumes.
  if ([...listing.values()].includes(name)) return name;
  return listing.get(name.toLowerCase()) || null;
}

/** Human grouping label used by the file browser: "Today — Sep 3, 2026". */
function groupLabel(date, now = new Date()) {
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86400000);
  const full = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  if (days === 0) return `Today — ${full}`;
  if (days === 1) return `Yesterday — ${full}`;
  if (days > 1 && days < 7) {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  return full;
}

/** Stable sort key so groups run newest-first. */
function groupKey(date) {
  return `${yyyy(date)}-${mm(date)}-${dd(date)}`;
}

module.exports = {
  DATE_FORMATS,
  DEFAULT_DATE_FORMAT,
  captureDate,
  dateSegments,
  resolveDatedDir,
  groupLabel,
  groupKey,
};
