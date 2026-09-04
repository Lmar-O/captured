'use strict';

const fsp = require('node:fs/promises');

/**
 * Read the frame rate out of a clip without shelling out to anything.
 *
 * The app cannot assume ffmpeg is installed and QuickLook will not tell us a
 * frame rate, so MP4/MOV files are parsed directly: both are ISO base media
 * containers, and the video track's sample table already carries exactly the
 * numbers we need. Only box headers are read, never the media data, so a
 * 40 GB clip costs the same handful of seeks as a 40 MB one.
 *
 * Formats outside that family (MTS, MXF, BRAW, R3D) fall back to the XML
 * sidecar a camera writes next to the clip; when neither works the caller
 * simply gets null and the file keeps its name.
 */

/** Containers laid out as ISO base media / QuickTime boxes. */
const BMFF_EXTS = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.3g2', '.insv', '.lrv']);

/**
 * Rates cameras actually shoot, paired with the number people say out loud.
 * A 120 fps card records 119.88 in NTSC territory, and a folder full of
 * `_119.88fps` files reads worse than one full of `_120fps`.
 */
const NOMINAL = [
  [23.976, 24], [24, 24], [25, 25], [29.97, 30], [30, 30],
  [47.952, 48], [48, 48], [50, 50], [59.94, 60], [60, 60],
  [90, 90], [100, 100], [119.88, 120], [120, 120],
  [200, 200], [239.76, 240], [240, 240], [400, 400], [480, 480],
];

/** Matches a frame rate this module already appended, so it is never doubled. */
const FPS_SUFFIX = /_\d+(?:\.\d+)?fps$/i;

/**
 * Turn a measured rate into the label that goes in the filename.
 *
 * Real footage lands close to a standard rate rather than on it — a clip
 * that reports 89.55 or 60.02 was shot at 90 and 60 — so anything within a
 * percent takes that rate's name. The standard rates are more than a percent
 * apart except for the NTSC pairs, which share a name anyway. Genuinely
 * unusual rates (a 37 fps time-lapse) keep their own number.
 */
function fpsLabel(fps) {
  if (fps == null || !Number.isFinite(fps) || fps <= 0 || fps > 2000) return null;

  for (const [rate, nominal] of NOMINAL) {
    if (Math.abs(fps - rate) / rate <= 0.01) return `${nominal}fps`;
  }

  const rounded = Math.round(fps);
  if (Math.abs(fps - rounded) < 0.05) return `${rounded}fps`;
  return `${Number(fps.toFixed(2))}fps`;
}

/** Drop a trailing `_120fps` so re-importing a renamed file does not stack them. */
function stripFpsSuffix(stem) {
  return stem.replace(FPS_SUFFIX, '');
}

/* ------------------------------------------------------------------ */
/* ISO base media parsing                                              */
/* ------------------------------------------------------------------ */

/**
 * Read one box header at `offset`.
 *
 * Boxes are `size(4) type(4)`, with `size === 1` meaning a 64-bit length
 * follows and `size === 0` meaning "the rest of the file".
 */
async function readHeader(fh, offset, limit) {
  if (offset + 8 > limit) return null;

  const head = Buffer.alloc(16);
  const { bytesRead } = await fh.read(head, 0, 16, offset);
  if (bytesRead < 8) return null;

  const type = head.toString('latin1', 4, 8);
  let size = head.readUInt32BE(0);
  let headerSize = 8;

  if (size === 1) {
    if (bytesRead < 16) return null;
    const large = head.readBigUInt64BE(8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }

  if (size < headerSize) return null;
  const end = Math.min(offset + size, limit);
  return { type, headerSize, start: offset, body: offset + headerSize, end };
}

/** First child box of `type` between `start` and `end`, or null. */
async function findBox(fh, start, end, type) {
  let offset = start;
  while (offset < end) {
    const box = await readHeader(fh, offset, end);
    if (!box) return null;
    if (box.type === type) return box;
    if (box.end <= offset) return null; // malformed: no forward progress
    offset = box.end;
  }
  return null;
}

/** Every child box of `type` between `start` and `end`. */
async function findBoxes(fh, start, end, type) {
  const out = [];
  let offset = start;
  while (offset < end) {
    const box = await readHeader(fh, offset, end);
    if (!box) break;
    if (box.type === type) out.push(box);
    if (box.end <= offset) break;
    offset = box.end;
  }
  return out;
}

/** Walk a chain of nested containers, e.g. mdia → minf → stbl. */
async function descend(fh, box, types) {
  let current = box;
  for (const type of types) {
    current = await findBox(fh, current.body, current.end, type);
    if (!current) return null;
  }
  return current;
}

/** True when this trak's handler says "video". */
async function isVideoTrack(fh, mdia) {
  const hdlr = await findBox(fh, mdia.body, mdia.end, 'hdlr');
  if (!hdlr) return false;

  // version/flags(4) pre_defined(4) handler_type(4)
  const buf = Buffer.alloc(4);
  const { bytesRead } = await fh.read(buf, 0, 4, hdlr.body + 8);
  return bytesRead === 4 && buf.toString('latin1') === 'vide';
}

/** Ticks per second for this track's media timeline. */
async function mediaTimescale(fh, mdia) {
  const mdhd = await findBox(fh, mdia.body, mdia.end, 'mdhd');
  if (!mdhd) return null;

  const buf = Buffer.alloc(24);
  const { bytesRead } = await fh.read(buf, 0, 24, mdhd.body);
  if (bytesRead < 20) return null;

  // Version 1 widens the creation/modification times to 64 bits, which
  // pushes the timescale from offset 12 to offset 20.
  const version = buf.readUInt8(0);
  const at = version === 1 ? 20 : 12;
  if (bytesRead < at + 4) return null;

  const timescale = buf.readUInt32BE(at);
  return timescale > 0 ? timescale : null;
}

/**
 * Average frame rate from the time-to-sample table.
 *
 * `stts` is a run-length list of frame durations, so summing counts and
 * durations gives the true average even for variable frame rate footage.
 */
async function framesFromStts(fh, stbl, timescale) {
  const stts = await findBox(fh, stbl.body, stbl.end, 'stts');
  if (!stts) return null;

  const head = Buffer.alloc(8);
  const read = await fh.read(head, 0, 8, stts.body);
  if (read.bytesRead < 8) return null;

  const declared = head.readUInt32BE(4);
  const available = Math.floor((stts.end - stts.body - 8) / 8);
  // Constant frame rate needs one entry; the cap only bounds a corrupt count.
  const count = Math.min(declared, available, 65536);
  if (count <= 0) return null;

  const table = Buffer.alloc(count * 8);
  const body = await fh.read(table, 0, table.length, stts.body + 8);
  if (body.bytesRead < 8) return null;

  let samples = 0;
  let ticks = 0;
  for (let i = 0; i + 8 <= body.bytesRead; i += 8) {
    const sampleCount = table.readUInt32BE(i);
    const delta = table.readUInt32BE(i + 4);
    samples += sampleCount;
    ticks += sampleCount * delta;
  }

  if (samples < 2 || ticks <= 0) return null;
  return (samples * timescale) / ticks;
}

/**
 * Frame rate of the first video track in an MP4/MOV file.
 *
 * `moov` sits at the end of the file on cards that write as they record, so
 * the top-level boxes are walked rather than assumed to start with it.
 */
async function probeBmff(fullPath) {
  let fh;
  try {
    fh = await fsp.open(fullPath, 'r');
    const { size } = await fh.stat();

    const moov = await findBox(fh, 0, size, 'moov');
    if (!moov) return null;

    for (const trak of await findBoxes(fh, moov.body, moov.end, 'trak')) {
      const mdia = await findBox(fh, trak.body, trak.end, 'mdia');
      if (!mdia || !(await isVideoTrack(fh, mdia))) continue;

      const timescale = await mediaTimescale(fh, mdia);
      if (!timescale) continue;

      const stbl = await descend(fh, mdia, ['minf', 'stbl']);
      if (!stbl) continue;

      const fps = await framesFromStts(fh, stbl, timescale);
      if (fps) return fps;
    }

    return null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Sidecar fallback                                                    */
/* ------------------------------------------------------------------ */

/**
 * Frame rate from a camera's XML sidecar.
 *
 * Sony and Panasonic write the shooting format beside every clip, which is
 * the only readable source for MXF and AVCHD footage. `captureFps` is the
 * rate the sensor ran at — the one that matters for slow motion — so it
 * wins over the playback rate when both are present.
 */
async function probeSidecar(sidecars = []) {
  const xml = sidecars.find((s) => (s.kind || s.ext || '').toLowerCase() === '.xml');
  if (!xml?.fullPath) return null;

  let text;
  try {
    const { size } = await fsp.stat(xml.fullPath);
    if (size > 2 * 1024 * 1024) return null;
    text = await fsp.readFile(xml.fullPath, 'utf8');
  } catch {
    return null;
  }

  const patterns = [
    /captureFps\s*=\s*"(\d+(?:\.\d+)?)/i,
    /formatFps\s*=\s*"(\d+(?:\.\d+)?)/i,
    /<VideoFrameRate>\s*(\d+(?:\.\d+)?)/i,
    /frameRate\s*=\s*"(\d+(?:\.\d+)?)/i,
  ];

  for (const re of patterns) {
    const hit = text.match(re);
    if (hit) {
      const fps = Number(hit[1]);
      if (Number.isFinite(fps) && fps > 0) return fps;
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Frame rate of one scanned file, or null when nothing can read it. */
async function probeFramerate(file) {
  const ext = (file.ext || '').toLowerCase();
  if (BMFF_EXTS.has(ext)) {
    const fps = await probeBmff(file.fullPath);
    if (fps) return fps;
  }
  return probeSidecar(file.sidecars);
}

/**
 * Annotate a scanned list with `framerate` and `fpsLabel`, in parallel but
 * bounded — a card reads a great deal faster a few files at a time than a
 * hundred at once.
 */
async function attachFramerates(files, { concurrency = 6 } = {}) {
  let next = 0;

  const worker = async () => {
    while (next < files.length) {
      const file = files[next];
      next += 1;
      const fps = await probeFramerate(file);
      file.framerate = fps;
      file.fpsLabel = fpsLabel(fps);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker),
  );

  return files;
}

module.exports = { attachFramerates, probeFramerate, fpsLabel, stripFpsSuffix };
