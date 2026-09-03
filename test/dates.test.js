'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveDatedDir, dateSegments, captureDate } = require('../electron/lib/dates');

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'captured-test-'));
}

const listing = async (dir) => (await fsp.readdir(dir)).sort();

test('creates the dated tree when nothing exists', async () => {
  const root = await tmpRoot();
  const segments = dateSegments(new Date(2026, 8, 3), 'YYYY/YYYY-MM-DD');

  const { dir, created } = await resolveDatedDir(root, segments);

  assert.equal(dir, path.join(root, '2026', '2026-09-03'));
  assert.deepEqual(created, [
    path.join(root, '2026'),
    path.join(root, '2026', '2026-09-03'),
  ]);
});

test('reuses an existing dated folder instead of creating a second one', async () => {
  const root = await tmpRoot();
  await fsp.mkdir(path.join(root, '2026', '2026-09-03'), { recursive: true });
  await fsp.writeFile(path.join(root, '2026', '2026-09-03', 'EXISTING.MP4'), 'x');

  const segments = dateSegments(new Date(2026, 8, 3), 'YYYY/YYYY-MM-DD');
  const { dir, created } = await resolveDatedDir(root, segments);

  assert.equal(dir, path.join(root, '2026', '2026-09-03'));
  assert.deepEqual(created, [], 'nothing should be created');
  assert.deepEqual(await listing(path.join(root, '2026')), ['2026-09-03']);
  // The file already in that folder is untouched.
  assert.deepEqual(await listing(dir), ['EXISTING.MP4']);
});

test('reuses an existing year but creates only the missing day', async () => {
  const root = await tmpRoot();
  await fsp.mkdir(path.join(root, '2026', '2026-08-30'), { recursive: true });

  const segments = dateSegments(new Date(2026, 8, 3), 'YYYY/YYYY-MM-DD');
  const { dir, created } = await resolveDatedDir(root, segments);

  assert.equal(dir, path.join(root, '2026', '2026-09-03'));
  assert.deepEqual(created, [path.join(root, '2026', '2026-09-03')]);
  assert.deepEqual(await listing(path.join(root, '2026')), ['2026-08-30', '2026-09-03']);
});

test('does not create a sibling that differs only in case', async () => {
  const root = await tmpRoot();
  await fsp.mkdir(path.join(root, 'DCIM-2026'), { recursive: true });

  const { dir, created } = await resolveDatedDir(root, ['dcim-2026']);

  assert.equal(dir, path.join(root, 'DCIM-2026'), 'reuses on-disk casing');
  assert.deepEqual(created, []);
  assert.deepEqual(await listing(root), ['DCIM-2026']);
});

test('create:false reports the path without touching disk', async () => {
  const root = await tmpRoot();
  const segments = dateSegments(new Date(2026, 8, 3), 'YYYY/YYYY-MM-DD');

  const { dir, created } = await resolveDatedDir(root, segments, new Map(), { create: false });

  assert.equal(dir, path.join(root, '2026', '2026-09-03'));
  assert.deepEqual(created, []);
  assert.deepEqual(await listing(root), [], 'nothing written');
});

test('create:false still resolves through folders that do exist', async () => {
  const root = await tmpRoot();
  await fsp.mkdir(path.join(root, '2026'), { recursive: true });

  const segments = dateSegments(new Date(2026, 8, 3), 'YYYY/YYYY-MM-DD');
  const { dir } = await resolveDatedDir(root, segments, new Map(), { create: false });

  assert.equal(dir, path.join(root, '2026', '2026-09-03'));
  assert.deepEqual(await listing(root), ['2026'], 'the day folder was not created');
});

test('all three date layouts resolve and reuse', async () => {
  const date = new Date(2026, 8, 3);
  assert.deepEqual(dateSegments(date, 'YYYY-MM-DD'), ['2026-09-03']);
  assert.deepEqual(dateSegments(date, 'YYYY/YYYY-MM-DD'), ['2026', '2026-09-03']);
  assert.deepEqual(dateSegments(date, 'YYYY/MM/DD'), ['2026', '09', '03']);

  const root = await tmpRoot();
  await fsp.mkdir(path.join(root, '2026', '09'), { recursive: true });
  const { dir, created } = await resolveDatedDir(root, dateSegments(date, 'YYYY/MM/DD'));

  assert.equal(dir, path.join(root, '2026', '09', '03'));
  assert.deepEqual(created, [path.join(root, '2026', '09', '03')]);
});

test('many files on the same date resolve to one folder', async () => {
  const root = await tmpRoot();
  const cache = new Map();
  const segments = dateSegments(new Date(2026, 8, 3), 'YYYY/YYYY-MM-DD');

  const results = [];
  for (let i = 0; i < 25; i += 1) {
    results.push(await resolveDatedDir(root, segments, cache));
  }

  const dirs = new Set(results.map((r) => r.dir));
  assert.equal(dirs.size, 1);
  assert.equal(results.flatMap((r) => r.created).length, 2, 'created exactly once');
  assert.deepEqual(await listing(path.join(root, '2026')), ['2026-09-03']);
});

test('concurrent resolution of the same date does not double-create', async () => {
  const root = await tmpRoot();
  const segments = dateSegments(new Date(2026, 8, 3), 'YYYY/YYYY-MM-DD');

  // Separate caches means every call races to mkdir the same paths.
  const results = await Promise.all(
    Array.from({ length: 12 }, () => resolveDatedDir(root, segments, new Map())),
  );

  const dirs = new Set(results.map((r) => r.dir));
  assert.equal(dirs.size, 1, 'all callers agree on one folder');
  assert.deepEqual(await listing(path.join(root, '2026')), ['2026-09-03']);
});

test('captureDate follows mtime, not birthtime', () => {
  const shot = new Date('2026-08-30T14:00:00Z');
  const installed = new Date('2026-02-04T09:00:00Z');

  // A metadata-preserving copy carries a birthtime older than the shoot;
  // mtime is what the camera wrote, so mtime wins.
  assert.equal(
    captureDate({ birthtimeMs: installed.getTime(), mtimeMs: shot.getTime() }).toISOString(),
    shot.toISOString(),
  );

  // A zeroed mtime, as some FAT32 readers report, falls back to birthtime.
  assert.equal(
    captureDate({ birthtimeMs: shot.getTime(), mtimeMs: 0 }).toISOString(),
    shot.toISOString(),
  );
});
