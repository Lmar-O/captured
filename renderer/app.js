'use strict';

const { icon } = window.CarbonIcons;
const api = window.captured;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  volumes: [],
  source: null,
  files: [],
  selected: new Set(),
  durations: new Map(),
  scanning: false,
  settings: null,
  dateFormats: [],
  plan: { existingDirs: [], newDirs: [], examplePath: null },
  importing: false,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function fmtSize(bytes) {
  if (bytes == null) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return null;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fileUrl(p) {
  return `file://${p.split('/').map(encodeURIComponent).join('/')}`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ------------------------------------------------------------------ */
/* Derived values                                                      */
/* ------------------------------------------------------------------ */

function selectedFiles() {
  return state.files.filter((f) => state.selected.has(f.id));
}

function selectedBytes() {
  const includeXml = state.settings?.includeXml;
  return selectedFiles().reduce(
    (sum, f) => sum + f.size + (includeXml ? f.sidecars.reduce((s, x) => s + x.size, 0) : 0),
    0,
  );
}

function groupedFiles() {
  const groups = new Map();
  for (const f of state.files) {
    if (!groups.has(f.groupKey)) {
      groups.set(f.groupKey, { key: f.groupKey, label: f.groupLabel, items: [] });
    }
    groups.get(f.groupKey).items.push(f);
  }
  return [...groups.values()];
}

/* ------------------------------------------------------------------ */
/* Source rail                                                         */
/* ------------------------------------------------------------------ */

function renderVolumes() {
  const host = $('volumes');

  if (!state.volumes.length) {
    host.innerHTML = '<div class="source__empty">Looking for volumes…</div>';
    return;
  }

  host.innerHTML = state.volumes.map((v) => {
    const selected = state.source === v.path;
    // The boot disk is listed for orientation but is not a card; importing
    // from it is still possible through "Choose folder…".
    const disabled = v.isBoot;
    const classes = [
      'cds-tile', 'source__tile',
      disabled ? 'cds-tile--disabled source__tile--disabled' : 'cds-tile--clickable',
      selected ? 'cds-tile--selected' : '',
    ].filter(Boolean).join(' ');

    const sub = disabled
      ? 'Internal disk'
      : `${fmtSize(v.freeBytes)} free of ${fmtSize(v.totalBytes)}`;

    return `
      <div class="${classes}" data-volume="${esc(v.path)}"
           ${disabled ? '' : 'role="button" tabindex="0"'}>
        <div class="source__row">
          ${icon(v.hasDcim || v.removable ? 'folder' : 'data--base', 20)}
          <div class="source__meta">
            <div class="source__name">${esc(v.name)}</div>
            <div class="source__sub">${esc(sub)}</div>
          </div>
        </div>
      </div>`;
  }).join('');

  for (const el of host.querySelectorAll('[data-volume][role="button"]')) {
    const activate = () => selectSource(el.dataset.volume);
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  }
}

async function selectSource(dir) {
  if (state.scanning) return;
  state.source = dir;
  renderVolumes();

  state.scanning = true;
  $('selection-count').textContent = 'Scanning…';
  $('groups').innerHTML = '';

  const result = await api.scan(dir, state.settings);
  state.scanning = false;

  if (result.error) {
    $('groups').innerHTML = `
      <div class="cds-notification cds-notification--error">
        <span class="cds-notification__icon">${icon('error--filled', 16)}</span>
        <div>
          <div class="cds-notification__title">Could not read that source</div>
          <div class="cds-notification__body">${esc(result.error)}</div>
        </div>
      </div>`;
    state.files = [];
    state.selected.clear();
    renderAll();
    return;
  }

  state.files = result.files;
  state.durations.clear();
  // Duplicates start deselected, matching "Skip suspected duplicates".
  state.selected = new Set(
    state.files.filter((f) => !(state.settings.skipDuplicates && f.duplicate)).map((f) => f.id),
  );

  renderFiles();
  await refreshPlan();
  renderAll();
}

/* ------------------------------------------------------------------ */
/* File grid                                                           */
/* ------------------------------------------------------------------ */

function renderFiles() {
  const host = $('groups');

  if (!state.source) {
    host.innerHTML = '<div class="source__empty">Select a card or folder to see what is on it.</div>';
    return;
  }
  if (!state.files.length) {
    host.innerHTML = '<div class="source__empty">No video files found here.</div>';
    return;
  }

  const groups = groupedFiles();

  host.innerHTML = groups.map((g) => {
    const all = g.items.every((f) => state.selected.has(f.id));
    const some = !all && g.items.some((f) => state.selected.has(f.id));

    return `
      <section class="group" data-group="${esc(g.key)}">
        <div class="group__header">
          <label class="cds-checkbox">
            <input type="checkbox" data-group-toggle="${esc(g.key)}" ${all ? 'checked' : ''}>
            <span class="cds-checkbox__box"></span>
          </label>
          <div class="group__label">${esc(g.label)}</div>
          <div class="group__count">(${g.items.length})</div>
        </div>
        <div class="group__grid">
          ${g.items.map((f, i) => cardHtml(f, i)).join('')}
        </div>
      </section>`;
  }).join('');

  // Indeterminate cannot be set from markup.
  for (const g of groups) {
    const box = host.querySelector(`[data-group-toggle="${CSS.escape(g.key)}"]`);
    const all = g.items.every((f) => state.selected.has(f.id));
    const some = g.items.some((f) => state.selected.has(f.id));
    if (box) box.indeterminate = !all && some;
  }

  wireCards();
  observeThumbs();
}

function cardHtml(file, index) {
  const checked = state.selected.has(file.id);
  const hue = index % 5;
  const duration = fmtDuration(state.durations.get(file.id));
  const meta = [duration, fmtSize(file.size)].filter(Boolean).join(' · ');
  const showXml = file.hasXml && state.settings?.includeXml;

  return `
    <div class="card ${checked ? '' : 'card--deselected'}" data-file="${esc(file.id)}"
         role="button" tabindex="0" title="${esc(file.relPath)}">
      <div class="card__thumb card__thumb--pending hue-${hue}" data-thumb="${esc(file.id)}">
        <div class="card__play"></div>
        <div class="card__check">
          <label class="cds-checkbox">
            <input type="checkbox" data-file-toggle="${esc(file.id)}" ${checked ? 'checked' : ''}>
            <span class="cds-checkbox__box"></span>
          </label>
        </div>
        ${file.duplicate ? '<div class="card__badge"><span class="cds-tag cds-tag--red">Duplicate</span></div>' : ''}
        <div class="card__caption">
          <div class="card__name-row">
            <div class="card__name">${esc(file.name)}</div>
            ${showXml ? '<span class="card__xml">+XML</span>' : ''}
          </div>
          <div class="card__meta" data-meta="${esc(file.id)}">${esc(meta)}</div>
        </div>
      </div>
    </div>`;
}

function wireCards() {
  for (const box of document.querySelectorAll('[data-file-toggle]')) {
    box.addEventListener('change', (e) => {
      e.stopPropagation();
      toggleFile(box.dataset.fileToggle);
    });
    box.closest('.card__check').addEventListener('click', (e) => e.stopPropagation());
  }

  for (const box of document.querySelectorAll('[data-group-toggle]')) {
    box.addEventListener('change', () => toggleGroup(box.dataset.groupToggle));
  }

  for (const card of document.querySelectorAll('.card')) {
    const activate = () => toggleFile(card.dataset.file);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  }
}

function toggleFile(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  syncSelectionUi();
}

function toggleGroup(key) {
  const items = state.files.filter((f) => f.groupKey === key);
  const all = items.every((f) => state.selected.has(f.id));
  for (const f of items) {
    if (all) state.selected.delete(f.id);
    else state.selected.add(f.id);
  }
  syncSelectionUi();
}

/** Update selection state in place — re-rendering would drop loaded thumbnails. */
function syncSelectionUi() {
  for (const card of document.querySelectorAll('.card')) {
    const on = state.selected.has(card.dataset.file);
    card.classList.toggle('card--deselected', !on);
    const box = card.querySelector('[data-file-toggle]');
    if (box) box.checked = on;
  }

  for (const g of groupedFiles()) {
    const box = document.querySelector(`[data-group-toggle="${CSS.escape(g.key)}"]`);
    if (!box) continue;
    const all = g.items.every((f) => state.selected.has(f.id));
    const some = g.items.some((f) => state.selected.has(f.id));
    box.checked = all;
    box.indeterminate = !all && some;
  }

  renderSummary();
  renderToolbar();
}

/* ------------------------------------------------------------------ */
/* Thumbnails and durations                                            */
/* ------------------------------------------------------------------ */

let thumbObserver = null;

function observeThumbs() {
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbObserver.unobserve(entry.target);
      loadThumb(entry.target.dataset.thumb, entry.target);
      loadDuration(entry.target.dataset.thumb);
    }
  }, { rootMargin: '300px' });

  for (const el of document.querySelectorAll('[data-thumb]')) thumbObserver.observe(el);
}

async function loadThumb(id, el) {
  const png = await api.thumbnail(id);
  if (!png || !el.isConnected) return;

  const img = document.createElement('img');
  img.src = fileUrl(png);
  img.alt = '';
  img.addEventListener('load', () => {
    el.classList.remove('card__thumb--pending');
    el.insertBefore(img, el.firstChild);
  }, { once: true });
}

const durationQueue = [];
let durationActive = 0;

function loadDuration(id) {
  if (state.durations.has(id)) return;
  durationQueue.push(id);
  pumpDurations();
}

function pumpDurations() {
  while (durationActive < 4 && durationQueue.length) {
    const id = durationQueue.shift();
    const file = state.files.find((f) => f.id === id);
    if (!file) continue;

    durationActive += 1;
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const done = (seconds) => {
      state.durations.set(id, seconds);
      video.removeAttribute('src');
      video.load();
      durationActive -= 1;

      const meta = document.querySelector(`[data-meta="${CSS.escape(id)}"]`);
      if (meta) {
        const label = fmtDuration(seconds);
        meta.textContent = [label, fmtSize(file.size)].filter(Boolean).join(' · ');
      }
      pumpDurations();
    };

    video.addEventListener('loadedmetadata', () => done(video.duration), { once: true });
    // Codecs Chromium cannot parse (BRAW, R3D, some MXF) simply show size.
    video.addEventListener('error', () => done(null), { once: true });
    video.src = fileUrl(file.fullPath);
  }
}

/* ------------------------------------------------------------------ */
/* Destination                                                         */
/* ------------------------------------------------------------------ */

function renderDestination() {
  const s = state.settings;

  $('dest-icon').innerHTML = icon('folder', 20);
  // Long paths matter more at the tail, so the element is RTL-trimmed; the
  // LRM keeps the leading slash rendering on the correct side.
  $('dest-path').textContent = s.destination ? `‎${s.destination}` : 'Choose a destination';
  $('dest-path').title = s.destination || '';

  $('organize-date').checked = s.organizeMode === 'date';
  $('organize-single').checked = s.organizeMode !== 'date';
  $('format-wrap').classList.toggle('hidden', s.organizeMode !== 'date');

  const select = $('date-format');
  if (select.options.length !== state.dateFormats.length) {
    select.innerHTML = state.dateFormats
      .map((f) => `<option value="${esc(f.value)}">${esc(f.label)}</option>`).join('');
  }
  select.value = s.dateFormat;
  $('format-chevron').innerHTML = icon('chevron--down', 16);

  $('opt-rename').checked = s.renameEnabled;
  $('rename-base').value = s.renameBase || '';
  $('rename-wrap').classList.toggle('hidden', !s.renameEnabled);
  $('rename-note').classList.toggle('hidden', s.renameEnabled);

  const base = (s.renameBase || '').trim();
  // Show the extension the import will actually write — clips keep the
  // spelling the camera used, so this is .MP4 on most cards, not .mp4.
  const ext = selectedFiles()[0]?.ext || state.files[0]?.ext || '.MP4';
  $('rename-helper').textContent = s.renameEnabled
    ? (base ? `${base}_1${ext}, ${base}_2${ext}, ${base}_3${ext}…` : 'Enter a name to preview numbering')
    : '';

  $('opt-xml').checked = s.includeXml;
  $('opt-skip-dupes').checked = s.skipDuplicates;
  $('opt-subfolders').checked = s.includeSubfolders;

  $('dest-example').textContent = state.plan.examplePath
    ? `e.g. ${state.plan.examplePath}`
    : '';

  renderFolderPlan();
}

/**
 * Spell out which dated folders already exist and which would be created.
 * This is the visible half of the "reuse, don't recreate" rule.
 */
function renderFolderPlan() {
  const host = $('folder-plan');
  const { existingDirs = [], newDirs = [] } = state.plan;

  if (state.settings.organizeMode !== 'date' || (!existingDirs.length && !newDirs.length)) {
    host.innerHTML = '';
    return;
  }

  const root = state.settings.destination;
  const rel = (p) => (p.startsWith(root) ? p.slice(root.length).replace(/^\//, '') : p);

  const rows = [
    ...existingDirs.map((d) => ({ flag: 'Existing', cls: 'reuse', path: rel(d) })),
    ...newDirs.map((d) => ({ flag: 'New', cls: 'new', path: rel(d) })),
  ].slice(0, 8);

  const extra = existingDirs.length + newDirs.length - rows.length;

  host.innerHTML = rows.map((r) => `
    <div class="folders__item">
      <span class="folders__flag folders__flag--${r.cls}">${r.flag}</span>
      <span>${esc(r.path || '.')}</span>
    </div>`).join('')
    + (extra > 0 ? `<div class="folders__item"><span>+${extra} more</span></div>` : '');
}

let planTimer = null;
function schedulePlan() {
  clearTimeout(planTimer);
  planTimer = setTimeout(refreshPlan, 180);
}

async function refreshPlan() {
  if (!state.files.length || !state.settings.destination) {
    state.plan = { existingDirs: [], newDirs: [], examplePath: null };
    renderDestination();
    return;
  }

  const plan = await api.planPreview(state.settings);
  state.plan = plan;

  let changed = false;
  for (const f of state.files) {
    const dupe = Boolean(plan.duplicates[f.id]);
    if (dupe !== f.duplicate) { f.duplicate = dupe; changed = true; }
  }

  if (changed) renderFiles();
  renderDestination();
  renderSummary();
  renderToolbar();
}

/* ------------------------------------------------------------------ */
/* Summary + toolbar                                                   */
/* ------------------------------------------------------------------ */

function renderSummary() {
  const sel = selectedFiles();
  const xmlCount = state.settings.includeXml
    ? sel.reduce((n, f) => n + f.sidecars.filter((s) => s.kind === '.xml').length, 0)
    : 0;
  const skipped = state.files.filter(
    (f) => f.duplicate && !state.selected.has(f.id),
  ).length;

  const rows = [
    `<div class="summary__row summary__row--primary">${icon('checkmark', 16)}
       ${sel.length} video${sel.length === 1 ? '' : 's'} selected · ${fmtSize(selectedBytes())}</div>`,
  ];

  if (state.settings.includeXml) {
    rows.push(`<div class="summary__row">${icon('document', 16)}
      ${xmlCount} XML file${xmlCount === 1 ? '' : 's'} will be imported</div>`);
  }
  if (skipped > 0) {
    rows.push(`<div class="summary__row summary__row--warning">${icon('warning--filled', 16)}
      ${skipped} duplicate${skipped === 1 ? '' : 's'} skipped</div>`);
  }

  $('summary').innerHTML = rows.join('');
}

function renderToolbar() {
  const sel = selectedFiles();
  const total = state.files.length;

  $('selection-count').textContent = total
    ? `${sel.length} of ${total} selected · ${fmtSize(selectedBytes())}`
    : (state.source ? 'Nothing to import' : 'No source selected');

  const btn = $('btn-import');
  btn.disabled = !sel.length || !state.settings.destination || state.importing;
  btn.textContent = sel.length
    ? `Import ${sel.length} video${sel.length === 1 ? '' : 's'}`
    : 'Import';
}

function renderAll() {
  renderVolumes();
  renderDestination();
  renderSummary();
  renderToolbar();
}

/* ------------------------------------------------------------------ */
/* Settings plumbing                                                   */
/* ------------------------------------------------------------------ */

async function updateSettings(patch, { rescan = false } = {}) {
  state.settings = { ...state.settings, ...patch };
  renderDestination();
  renderSummary();
  renderToolbar();

  api.settings.set(patch);

  if (rescan && state.source) await selectSource(state.source);
  else schedulePlan();
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

let progressOff = null;

async function startImport() {
  const files = selectedFiles();
  if (!files.length) return;

  const pre = await api.importer.preflight(files.map((f) => f.id), state.settings);

  if (!pre.destinationOk) {
    showResult({
      title: 'Cannot write to that destination',
      body: pre.destinationError || 'The folder could not be created.',
      error: true,
    });
    return;
  }

  if (!pre.enoughSpace) {
    showResult({
      title: 'Not enough space',
      body: `This import needs ${fmtSize(pre.bytes)} but only ${fmtSize(pre.freeBytes)} is free.`,
      error: true,
    });
    return;
  }

  state.importing = true;
  renderToolbar();
  openOverlay(pre);

  progressOff = api.importer.onProgress(onProgress);
  const result = await api.importer.run(files.map((f) => f.id), state.settings);
  progressOff?.();
  progressOff = null;

  state.importing = false;
  showImportResult(result);

  // The destination changed underneath us, so duplicates need recomputing.
  if (state.source) await selectSource(state.source);
}

function openOverlay(pre) {
  $('overlay').classList.remove('hidden');
  $('overlay-title').textContent = 'Importing';
  $('overlay-sub').textContent =
    `${pre.fileCount} file${pre.fileCount === 1 ? '' : 's'} · ${fmtSize(pre.bytes)}`;
  $('progress-track').classList.remove('hidden');
  $('progress-fill').style.width = '0%';
  $('overlay-list').classList.add('hidden');
  $('btn-cancel-import').classList.remove('hidden');
  $('btn-reveal').classList.add('hidden');
  $('btn-done').classList.add('hidden');
}

function onProgress(p) {
  const pct = p.totalBytes ? Math.min(100, (p.bytesDone / p.totalBytes) * 100) : 0;
  $('progress-fill').style.width = `${pct}%`;
  $('overlay-file').textContent = p.current ? p.current.name : '';
  $('overlay-bytes').textContent = `${fmtSize(p.bytesDone)} of ${fmtSize(p.totalBytes)}`;

  const rate = p.elapsedMs > 500 ? p.bytesDone / (p.elapsedMs / 1000) : 0;
  $('overlay-rate').textContent = rate ? `${fmtSize(rate)}/s` : '';
}

function showImportResult(result) {
  const copied = result.copied?.length || 0;
  const failed = result.failed?.length || 0;

  $('overlay-title').textContent = result.cancelled
    ? 'Import cancelled'
    : failed ? 'Import finished with errors' : 'Import complete';

  const parts = [`${copied} file${copied === 1 ? '' : 's'} copied`];
  if (result.createdDirs?.length) {
    parts.push(`${result.createdDirs.length} folder${result.createdDirs.length === 1 ? '' : 's'} created`);
  }
  if (failed) parts.push(`${failed} failed`);
  $('overlay-sub').textContent = parts.join(' · ');

  $('progress-fill').style.width = '100%';
  $('overlay-file').textContent = '';
  $('overlay-bytes').textContent = '';
  $('overlay-rate').textContent = '';

  if (failed) {
    const list = $('overlay-list');
    list.classList.remove('hidden');
    list.innerHTML = result.failed
      .map((f) => `<div class="overlay__error">${esc(f.name)} — ${esc(f.error)}</div>`)
      .join('');
  }

  $('btn-cancel-import').classList.add('hidden');
  $('btn-done').classList.remove('hidden');

  const first = result.copied?.[0];
  if (first) {
    $('btn-reveal').classList.remove('hidden');
    $('btn-reveal').onclick = () => api.reveal(first.to);
  }
}

function showResult({ title, body, error }) {
  $('overlay').classList.remove('hidden');
  $('overlay-title').textContent = title;
  $('overlay-sub').textContent = body;
  $('progress-track').classList.add('hidden');
  $('overlay-file').textContent = '';
  $('overlay-bytes').textContent = '';
  $('overlay-rate').textContent = '';
  $('overlay-list').classList.add('hidden');
  $('btn-cancel-import').classList.add('hidden');
  $('btn-reveal').classList.add('hidden');
  $('btn-done').classList.remove('hidden');
  if (error) $('overlay-title').classList.add('overlay__error');
}

function closeOverlay() {
  $('overlay').classList.add('hidden');
  $('overlay-title').classList.remove('overlay__error');
  $('progress-track').classList.remove('hidden');
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function wire() {
  $('btn-browse-source').addEventListener('click', async () => {
    const dir = await api.chooseFolder({ title: 'Choose a source folder' });
    if (dir) await selectSource(dir);
  });

  $('btn-browse-dest').addEventListener('click', async () => {
    const dir = await api.chooseFolder({
      title: 'Choose a destination folder',
      defaultPath: state.settings.destination,
    });
    if (dir) await updateSettings({ destination: dir });
  });

  $('btn-rescan').addEventListener('click', async () => {
    state.volumes = await api.volumes.list();
    renderVolumes();
    if (state.source) await selectSource(state.source);
  });

  $('btn-select-all').addEventListener('click', () => {
    state.selected = new Set(state.files.map((f) => f.id));
    syncSelectionUi();
  });

  $('btn-select-none').addEventListener('click', () => {
    state.selected.clear();
    syncSelectionUi();
  });

  $('btn-import').addEventListener('click', startImport);
  $('btn-cancel-import').addEventListener('click', () => api.importer.cancel());
  $('btn-done').addEventListener('click', closeOverlay);

  $('organize-single').addEventListener('change', () => updateSettings({ organizeMode: 'single' }));
  $('organize-date').addEventListener('change', () => updateSettings({ organizeMode: 'date' }));
  $('date-format').addEventListener('change', (e) => updateSettings({ dateFormat: e.target.value }));

  $('opt-rename').addEventListener('change', (e) => updateSettings({ renameEnabled: e.target.checked }));
  $('rename-base').addEventListener('input', (e) => updateSettings({ renameBase: e.target.value }));

  $('opt-xml').addEventListener('change', (e) => {
    updateSettings({ includeXml: e.target.checked });
    renderFiles();
  });

  $('opt-skip-dupes').addEventListener('change', (e) => {
    const skip = e.target.checked;
    // Turning the option on drops duplicates from the selection; turning it
    // off puts them back, which is what the design's toggle does.
    for (const f of state.files) {
      if (!f.duplicate) continue;
      if (skip) state.selected.delete(f.id);
      else state.selected.add(f.id);
    }
    updateSettings({ skipDuplicates: skip });
    syncSelectionUi();
  });

  $('opt-subfolders').addEventListener('change', (e) => {
    updateSettings({ includeSubfolders: e.target.checked }, { rescan: true });
  });

  api.onThemeChange(applySystemTheme);
}

function applySystemTheme(mode) {
  document.documentElement.dataset.carbonTheme = mode === 'dark' ? 'g100' : 'white';
}

async function init() {
  const loaded = await api.settings.get();
  state.dateFormats = loaded.dateFormats;
  state.settings = loaded;
  applySystemTheme(loaded.systemDark ? 'dark' : 'light');

  wire();
  renderAll();
  renderFiles();

  state.volumes = await api.volumes.list();
  renderVolumes();

  // Land on the card if one is plugged in — that is why the app was opened.
  const card = loaded.initialSource
    || state.volumes.find((v) => v.hasDcim)?.path
    || state.volumes.find((v) => v.removable)?.path;
  if (card) await selectSource(card);
}

init();
