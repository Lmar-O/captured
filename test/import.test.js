'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { scanSource, markDuplicates } = require('../electron/lib/scan');
const { planImport, runImport } = require('../electron/lib/importer');

const SRC_A = '/System/Library/CoreServices/BluetoothUIService.app/Contents/Resources/Banner-PID-8203-Case-mov/Banner-PID-8203-Case-Loop.mov';
const SRC_B = '/System/Library/CoreServices/NotificationCenter.app/Contents/Resources/mac_widgets-edu_RTL_full.mov';

/**
 * A card with three shoot dates, XML sidecars, and a nested DCIM layout.
 *
 * The sidecar column is the XML's own basename, not a flag — Sony tags its
 * metadata file "C0041M01.XML" beside "C0041.MP4", so a fixture that only ever
 * uses the clip's own name would miss the naming the scanner actually meets.
 */
async function makeCard() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'captured-card-'));
  const dir = path.join(root, 'DCIM', '100MEDIA');
  await fsp.mkdir(dir, { recursive: true });

  const spec = [
    ['DJI_0141', '2026-09-03', 'DJI_0141', SRC_A],
    ['DJI_0142', '2026-09-03', 'DJI_0142', SRC_B],
    ['DJI_0143', '2026-09-03', null, SRC_A],
    ['MVI_0231', '2026-09-02', 'MVI_0231M01', SRC_B],
    ['MVI_0232', '2026-09-02', null, SRC_A],
    ['C0041', '2026-08-30', 'C0041M01', SRC_B],
    ['C0042', '2026-08-30', null, SRC_A],
  ];

  for (const [name, date, xml, src] of spec) {
    const stamp = new Date(`${date}T12:00:00`);
    await fsp.copyFile(src, path.join(dir, `${name}.MP4`));
    await fsp.utimes(path.join(dir, `${name}.MP4`), stamp, stamp);
    if (xml) {
      await fsp.writeFile(path.join(dir, `${xml}.XML`), '<?xml version="1.0"?><meta/>');
      await fsp.utimes(path.join(dir, `${xml}.XML`), stamp, stamp);
    }
  }

  // Noise the scanner must ignore. DJI writes a low-res proxy beside every
  // clip: .LRV on older bodies, .LRF on current ones.
  await fsp.writeFile(path.join(dir, 'DJI_0141.LRV'), 'proxy');
  await fsp.writeFile(path.join(dir, 'DJI_0142.LRF'), 'proxy');
  await fsp.writeFile(path.join(dir, '.DS_Store'), 'x');
  await fsp.mkdir(path.join(root, '.Spotlight-V100'), { recursive: true });
  await fsp.writeFile(path.join(root, '.Spotlight-V100', 'IGNORE.MP4'), 'x');

  return root;
}

const tree = async (root) => {
  const out = [];
  async function walk(dir) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      out.push(path.relative(root, full));
      if (e.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return out.sort();
};

const baseSettings = (destination) => ({
  destination,
  organizeMode: 'date',
  dateFormat: 'YYYY/YYYY-MM-DD',
  renameEnabled: false,
  renameBase: '',
  includeXml: true,
  skipDuplicates: true,
});

test('scan finds only real videos, grouped by shoot date, with sidecars attached', async () => {
  const card = await makeCard();
  const files = await scanSource(card, { recursive: true });

  assert.equal(files.length, 7, 'LRV/LRF proxies, .DS_Store and .Spotlight-V100 are excluded');

  const groups = [...new Set(files.map((f) => f.groupKey))];
  assert.deepEqual(groups, ['2026-09-03', '2026-09-02', '2026-08-30'], 'newest group first');

  const withXml = files.filter((f) => f.hasXml).map((f) => f.name).sort();
  assert.deepEqual(withXml, ['C0041.MP4', 'DJI_0141.MP4', 'DJI_0142.MP4', 'MVI_0231.MP4']);
});

test('DJI proxies are never mistaken for clips, in either spelling', async () => {
  const card = await makeCard();
  const files = await scanSource(card, { recursive: true });

  assert.deepEqual(
    files.filter((f) => ['.LRV', '.LRF'].includes(f.ext)).map((f) => f.name),
    [],
    'the old .LRV and the current .LRF are both excluded',
  );
  assert.ok(
    files.some((f) => f.name === 'DJI_0142.MP4'),
    'excluding the proxy does not take the clip with it',
  );
});

test('scan without subfolders finds nothing at the card root', async () => {
  const card = await makeCard();
  const files = await scanSource(card, { recursive: false });
  assert.equal(files.length, 0, 'clips live under DCIM/100MEDIA');
});

test('import reuses an existing dated folder and creates only the missing ones', async () => {
  const card = await makeCard();
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'captured-dest-'));

  // The folder for one of the three dates is already on disk, with a file in
  // it that must survive untouched.
  await fsp.mkdir(path.join(dest, '2026', '2026-09-03'), { recursive: true });
  await fsp.writeFile(path.join(dest, '2026', '2026-09-03', 'PRIOR.MP4'), 'prior');

  const files = await scanSource(card, { recursive: true });
  const result = await runImport(files, baseSettings(dest));

  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(result.copied.length, 7);

  // 2026 and 2026-09-03 were reused; only the two missing day folders made.
  assert.deepEqual(result.createdDirs.sort(), [
    path.join(dest, '2026', '2026-08-30'),
    path.join(dest, '2026', '2026-09-02'),
  ]);

  const listing = await tree(dest);
  assert.deepEqual(listing.filter((p) => !p.includes('.')), [
    '2026',
    path.join('2026', '2026-08-30'),
    path.join('2026', '2026-09-02'),
    path.join('2026', '2026-09-03'),
  ], 'exactly one year folder, three day folders');

  assert.ok(listing.includes(path.join('2026', '2026-09-03', 'PRIOR.MP4')), 'existing file kept');
  assert.ok(listing.includes(path.join('2026', '2026-09-03', 'DJI_0141.MP4')));
  assert.ok(listing.includes(path.join('2026', '2026-09-03', 'DJI_0141.XML')), 'sidecar rode along');
  assert.ok(listing.includes(path.join('2026', '2026-08-30', 'C0041.MP4')));
  assert.ok(
    listing.includes(path.join('2026', '2026-08-30', 'C0041.XML')),
    'a Sony C0041M01.XML lands beside its clip, named to match',
  );
});

test('a second import of the same card flags every file as a duplicate', async () => {
  const card = await makeCard();
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'captured-dest-'));
  const settings = baseSettings(dest);

  const first = await scanSource(card, { recursive: true });
  await runImport(first, settings);

  const second = await scanSource(card, { recursive: true });
  const { targets } = await planImport(second, settings, { create: false });
  await markDuplicates(second, targets);

  assert.equal(second.filter((f) => f.duplicate).length, 7, 'all seven already there');

  // Nothing new is created when the whole selection is skipped.
  const before = await tree(dest);
  await runImport([], settings);
  assert.deepEqual(await tree(dest), before);
});

test('copied bytes and capture timestamps match the source', async () => {
  const card = await makeCard();
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'captured-dest-'));

  const files = await scanSource(card, { recursive: true });
  const result = await runImport(files, baseSettings(dest));

  for (const copied of result.copied) {
    const src = files.find((f) => f.id === copied.id);
    const a = await fsp.stat(src.fullPath);
    const b = await fsp.stat(copied.to);
    assert.equal(b.size, a.size, `${copied.name} size`);
    assert.equal(
      Math.round(b.mtimeMs / 1000),
      Math.round(a.mtimeMs / 1000),
      `${copied.name} keeps its capture time`,
    );
  }
});

test('renaming numbers the whole selection in shot order and renames sidecars to match', async () => {
  const card = await makeCard();
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'captured-dest-'));

  const files = await scanSource(card, { recursive: true });
  const result = await runImport(files, {
    ...baseSettings(dest),
    renameEnabled: true,
    renameBase: '  Japan  ',
  });

  assert.equal(result.failed.length, 0);

  const listing = (await tree(dest)).filter((p) => p.endsWith('.MP4') || p.endsWith('.XML'));
  const names = listing.map((p) => path.basename(p)).sort();

  assert.deepEqual(names, [
    'Japan_1.MP4', 'Japan_1.XML',   // C0041, Aug 30 — earliest shot
    'Japan_2.MP4',                  // C0042, Aug 30
    'Japan_3.MP4', 'Japan_3.XML',   // MVI_0231, Sep 2
    'Japan_4.MP4',                  // MVI_0232, Sep 2
    'Japan_5.MP4', 'Japan_5.XML',   // DJI_0141, Sep 3
    'Japan_6.MP4', 'Japan_6.XML',   // DJI_0142, Sep 3
    'Japan_7.MP4',                  // DJI_0143, Sep 3
  ].sort());

  // Numbering runs across dates, so the earliest clip lands in the Aug 30 folder.
  assert.ok(listing.includes(path.join('2026', '2026-08-30', 'Japan_1.MP4')));
  assert.ok(listing.includes(path.join('2026', '2026-09-03', 'Japan_7.MP4')));
});

test('a same-named file of different content is parked beside, never overwritten', async () => {
  const card = await makeCard();
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'captured-dest-'));

  // Different footage that happens to share a filename after a card format.
  const clash = path.join(dest, '2026', '2026-09-03');
  await fsp.mkdir(clash, { recursive: true });
  await fsp.writeFile(path.join(clash, 'DJI_0141.MP4'), 'different footage');

  const files = await scanSource(card, { recursive: true });
  const result = await runImport(files, baseSettings(dest));

  assert.equal(result.failed.length, 0);
  assert.equal(
    await fsp.readFile(path.join(clash, 'DJI_0141.MP4'), 'utf8'),
    'different footage',
    'the original is untouched',
  );
  assert.ok((await tree(dest)).includes(path.join('2026', '2026-09-03', 'DJI_0141-1.MP4')));
});

test('organize into one folder skips date subfolders entirely', async () => {
  const card = await makeCard();
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'captured-dest-'));

  const files = await scanSource(card, { recursive: true });
  const result = await runImport(files, { ...baseSettings(dest), organizeMode: 'single' });

  assert.deepEqual(result.createdDirs, []);
  const listing = await tree(dest);
  assert.ok(listing.every((p) => !p.includes(path.sep)), 'flat destination');
  assert.equal(listing.filter((p) => p.endsWith('.MP4')).length, 7);
});

test('turning XML off leaves sidecars on the card', async () => {
  const card = await makeCard();
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'captured-dest-'));

  const files = await scanSource(card, { recursive: true });
  await runImport(files, { ...baseSettings(dest), includeXml: false });

  const listing = await tree(dest);
  assert.equal(listing.filter((p) => p.endsWith('.XML')).length, 0);
  assert.equal(listing.filter((p) => p.endsWith('.MP4')).length, 7);
});

test('cancelling mid-import leaves no partial files behind', async () => {
  const card = await makeCard();
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'captured-dest-'));

  const files = await scanSource(card, { recursive: true });
  const controller = new AbortController();

  let seen = 0;
  const result = await runImport(files, baseSettings(dest), {
    signal: controller.signal,
    onProgress: () => {
      seen += 1;
      if (seen === 3) controller.abort();
    },
  });

  assert.ok(result.cancelled, 'reported as cancelled');
  assert.ok(result.copied.length < files.length, 'stopped early');

  const listing = await tree(dest);
  assert.equal(
    listing.filter((p) => p.endsWith('.captured-part')).length,
    0,
    'no half-written clips',
  );
  for (const copied of result.copied) {
    const src = files.find((f) => f.id === copied.id);
    assert.equal((await fsp.stat(copied.to)).size, src.size, 'finished files are complete');
  }
});
