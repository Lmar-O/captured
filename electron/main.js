'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { listVolumes } = require('./lib/volumes');
const { scanSource, markDuplicates } = require('./lib/scan');
const { planImport, runImport, freeSpace } = require('./lib/importer');
const { ThumbnailCache } = require('./lib/thumbs');
const { DATE_FORMATS, DEFAULT_DATE_FORMAT } = require('./lib/dates');

let win = null;
let thumbs = null;
let settingsPath = null;
let importAbort = null;

/** Last scan, kept so the renderer can send ids instead of whole file records. */
let scanned = [];

const DEFAULT_SETTINGS = {
  destination: path.join(os.homedir(), 'Movies', 'Imports'),
  organizeMode: 'date',
  dateFormat: DEFAULT_DATE_FORMAT,
  renameEnabled: false,
  renameBase: '',
  includeXml: true,
  skipDuplicates: true,
  includeSubfolders: true,
  theme: 'system',
};

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    // The mockup draws its own traffic lights inside a 56px bar. On a real
    // Mac we let the system draw them and inset them into that same bar, so
    // the window behaves like a native one (drag, double-click to zoom).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 21 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161616' : '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  thumbs = new ThumbnailCache(path.join(app.getPath('userData'), 'thumbnails'));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

nativeTheme.on('updated', () => {
  win?.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
});

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

async function readSettings() {
  try {
    const raw = await fsp.readFile(settingsPath, 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * `--source=<dir>` / `--destination=<dir>` preselect the panes at launch, so
 * the app can be pointed at a card from a script or a Finder "open with"
 * without going through the folder pickers.
 */
function argPath(flag) {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? path.resolve(hit.slice(flag.length + 3)) : null;
}

ipcMain.handle('settings:get', async () => ({
  ...(await readSettings()),
  ...(argPath('destination') ? { destination: argPath('destination') } : {}),
  initialSource: argPath('source'),
  dateFormats: Object.entries(DATE_FORMATS).map(([value, spec]) => ({
    value,
    label: spec.label,
  })),
  systemDark: nativeTheme.shouldUseDarkColors,
  home: os.homedir(),
}));

ipcMain.handle('settings:set', async (_event, patch) => {
  const next = { ...(await readSettings()), ...patch };
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(next, null, 2));
  return next;
});

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

ipcMain.handle('volumes:list', () => listVolumes());

ipcMain.handle('dialog:chooseFolder', async (_event, { title, defaultPath } = {}) => {
  const result = await dialog.showOpenDialog(win, {
    title: title || 'Choose folder',
    defaultPath: defaultPath || os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Choose',
  });
  return result.canceled ? null : result.filePaths[0];
});

/**
 * Scan a source and report what is importable, already annotated with the
 * duplicate state for the destination settings in play. Duplicates depend on
 * where each file would land, so the scan and the plan share one code path.
 */
ipcMain.handle('scan:run', async (_event, { source, settings }) => {
  thumbs.clearQueue();

  let files;
  try {
    files = await scanSource(source, { recursive: settings.includeSubfolders !== false });
  } catch (err) {
    return { error: err.message, files: [] };
  }

  if (settings.destination) {
    try {
      const { targets } = await planImport(files, settings, { create: false });
      await markDuplicates(files, targets);
    } catch (err) {
      // A missing or unreadable destination just means nothing is a known
      // duplicate yet; the destination pane surfaces the real problem.
      for (const f of files) f.duplicate = false;
    }
  } else {
    for (const f of files) f.duplicate = false;
  }

  scanned = files;
  return { files, source };
});

/**
 * Recompute duplicates and the example path when destination settings change,
 * without re-walking the card.
 */
ipcMain.handle('plan:preview', async (_event, { settings }) => {
  if (!scanned.length || !settings.destination) {
    return { duplicates: {}, examplePath: null, createdDirs: [] };
  }

  const { targets, createdDirs } = await planImport(scanned, settings, { create: false });
  await markDuplicates(scanned, targets);

  const duplicates = {};
  for (const f of scanned) duplicates[f.id] = Boolean(f.duplicate);

  const first = scanned.find((f) => targets.has(f.id));
  const target = first ? targets.get(first.id) : null;

  // Which dated folders are already on disk vs. would be created — this is
  // what the destination pane reports back to the user before they commit.
  const existing = [];
  const missing = [];
  const seen = new Set();
  for (const t of targets.values()) {
    if (seen.has(t.dir)) continue;
    seen.add(t.dir);
    try {
      await fsp.access(t.dir);
      existing.push(t.dir);
    } catch {
      missing.push(t.dir);
    }
  }

  return {
    duplicates,
    examplePath: target ? target.fullPath : null,
    existingDirs: existing,
    newDirs: missing,
    createdDirs,
  };
});

ipcMain.handle('thumb:get', async (_event, { id }) => {
  const file = scanned.find((f) => f.id === id);
  if (!file) return null;
  return thumbs.request(file);
});

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

ipcMain.handle('import:preflight', async (_event, { ids, settings }) => {
  const files = scanned.filter((f) => ids.includes(f.id));
  const bytes = files.reduce(
    (sum, f) => sum + f.size + (settings.includeXml ? f.sidecars.reduce((s, x) => s + x.size, 0) : 0),
    0,
  );

  let destinationOk = true;
  let destinationError = null;
  try {
    await fsp.mkdir(settings.destination, { recursive: true });
    await fsp.access(settings.destination);
  } catch (err) {
    destinationOk = false;
    destinationError = err.message;
  }

  const free = destinationOk ? await freeSpace(settings.destination) : null;

  return {
    fileCount: files.length,
    bytes,
    freeBytes: free,
    enoughSpace: free == null ? true : free > bytes * 1.02,
    destinationOk,
    destinationError,
  };
});

ipcMain.handle('import:run', async (event, { ids, settings }) => {
  const files = scanned.filter((f) => ids.includes(f.id));
  if (!files.length) return { copied: [], failed: [], skipped: [] };

  importAbort = new AbortController();

  try {
    const result = await runImport(files, settings, {
      signal: importAbort.signal,
      onProgress: (p) => event.sender.send('import:progress', p),
    });
    return result;
  } finally {
    importAbort = null;
  }
});

ipcMain.handle('import:cancel', () => {
  importAbort?.abort();
  return true;
});

ipcMain.handle('shell:reveal', (_event, { target }) => {
  shell.showItemInFolder(target);
  return true;
});

ipcMain.handle('shell:openPath', async (_event, { target }) => shell.openPath(target));
