'use strict';

/**
 * A stand-in for the preload bridge so the Import screen can be opened in a
 * plain browser for design work. Same shapes the real IPC returns; no disk
 * access. Only dev/preview.html loads this — the app never does.
 */
(() => {
  const DAY = 86400000;
  const iso = (daysAgo, hour) =>
    new Date(new Date(2026, 8, 3, hour, 0, 0).getTime() - daysAgo * DAY).toISOString();

  const RAW = [
    ['DJI_0141.MP4', 0, 512, true, true], ['DJI_0142.MP4', 0, 210, true, false],
    ['DJI_0143.MP4', 0, 890, false, false], ['DJI_0144.MP4', 0, 340, true, true],
    ['DJI_0145.MP4', 0, 710, false, false], ['DJI_0146.MP4', 0, 220, true, false],
    ['DJI_0147.MP4', 0, 601, false, true], ['DJI_0148.MP4', 0, 260, false, false],
    ['MVI_0231.MP4', 1, 1126, false, false], ['MVI_0232.MP4', 1, 140, true, false],
    ['MVI_0233.MP4', 1, 480, false, true], ['MVI_0234.MP4', 1, 820, true, false],
    ['MVI_0235.MP4', 1, 260, false, false], ['MVI_0236.MP4', 1, 96, true, false],
    ['C0041.MP4', 4, 1331, false, false], ['C0042.MP4', 4, 590, true, false],
    ['C0043.MP4', 4, 175, false, false], ['C0044.MP4', 4, 940, true, false],
  ];

  const label = (d) => (d === 0 ? 'Today — Sep 3, 2026'
    : d === 1 ? 'Yesterday — Sep 2, 2026' : 'Saturday, Aug 30, 2026');
  const key = (d) => (d === 0 ? '2026-09-03' : d === 1 ? '2026-09-02' : '2026-08-30');

  // A card that shot a mix of rates, plus one clip nothing can read.
  const FPS = ['120fps', '24fps', '60fps', '30fps', '120fps', null];

  const files = RAW.map(([name, days, mb, hasXml, duplicate], i) => ({
    id: `f${i + 1}`,
    name,
    base: name.replace(/\.MP4$/, ''),
    ext: '.MP4',
    fullPath: `/Volumes/NIKON SD/DCIM/100MEDIA/${name}`,
    relPath: `DCIM/100MEDIA/${name}`,
    size: mb * 1024 * 1024,
    mtimeMs: Date.now(),
    capturedAt: iso(days, 12 - (i % 6)),
    groupKey: key(days),
    groupLabel: label(days),
    sidecars: hasXml
      ? [{ name: name.replace(/MP4$/, 'XML'), fullPath: '', size: 4096, ext: '.XML', kind: '.xml' }]
      : [],
    hasXml,
    duplicate,
    fpsLabel: FPS[i % FPS.length],
  }));

  const settings = {
    destination: '/Users/you/Movies/Imports',
    organizeMode: 'date',
    dateFormat: 'YYYY/YYYY-MM-DD',
    renameEnabled: false,
    renameBase: '',
    framerateSuffix: false,
    includeXml: true,
    skipDuplicates: true,
    includeSubfolders: true,
  };

  window.captured = {
    settings: {
      get: async () => ({
        ...settings,
        initialSource: '/Volumes/NIKON SD',
        dateFormats: [
          { value: 'YYYY-MM-DD', label: '2026-09-03' },
          { value: 'YYYY/YYYY-MM-DD', label: '2026/2026-09-03' },
          { value: 'YYYY/MM/DD', label: '2026/09/03' },
        ],
        systemDark: false,
        home: '/Users/you',
      }),
      set: async (patch) => Object.assign(settings, patch),
    },
    volumes: {
      list: async () => ([
        { path: '/Volumes/NIKON SD', name: 'NIKON SD', removable: true, isBoot: false,
          totalBytes: 64e9, freeBytes: 58.2e9, hasDcim: true },
        { path: '/Volumes/Samsung T7', name: 'Samsung T7', removable: true, isBoot: false,
          totalBytes: 2e12, freeBytes: 1.4e12, hasDcim: false },
        { path: '/', name: 'Macintosh HD', removable: false, isBoot: true,
          totalBytes: 1e12, freeBytes: 380e9, hasDcim: false },
      ]),
    },
    chooseFolder: async () => '/Users/you/Movies/Imports',
    scan: async () => ({ files, source: '/Volumes/NIKON SD' }),
    planPreview: async (s) => ({
      duplicates: Object.fromEntries(files.map((f) => [f.id, f.duplicate])),
      examplePath: `${s.destination}${s.organizeMode === 'date' ? '/2026/2026-09-03' : ''}/`
        + (s.renameEnabled && s.renameBase.trim() ? `${s.renameBase.trim()}_1` : 'DJI_0141')
        + (s.framerateSuffix ? '_120fps' : '') + '.MP4',
      existingDirs: [`${s.destination}/2026/2026-09-03`, `${s.destination}/2026/2026-09-02`],
      newDirs: [`${s.destination}/2026/2026-08-30`],
    }),
    thumbnail: async () => null,
    importer: {
      preflight: async (ids) => ({ fileCount: ids.length, bytes: 6e9, freeBytes: 5e11,
        enoughSpace: true, destinationOk: true }),
      run: async (ids) => ({ copied: [], failed: [], skipped: [], createdDirs: [] }),
      cancel: async () => true,
      onProgress: () => () => {},
    },
    reveal: async () => true,
    openPath: async () => '',
    onThemeChange: () => () => {},
  };
})();
