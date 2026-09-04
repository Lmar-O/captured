'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  attachFramerates, probeFramerate, fpsLabel, stripFpsSuffix,
} = require('../electron/lib/framerate');

/** A real 60 fps QuickTime file that ships with macOS. */
const REAL_MOV = '/System/Library/CoreServices/BluetoothUIService.app/Contents/Resources/Banner-PID-8203-Case-mov/Banner-PID-8203-Case-Loop.mov';

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'captured-fps-'));

test('reads the frame rate straight out of a real QuickTime file', async () => {
  const fps = await probeFramerate({ fullPath: REAL_MOV, ext: '.mov', sidecars: [] });
  assert.ok(Math.abs(fps - 60) < 0.1, `expected ~60, got ${fps}`);
  assert.equal(fpsLabel(fps), '60fps');
});

test('a card that writes .MP4 in caps is still parsed', async () => {
  const dir = await tmpDir();
  const clip = path.join(dir, 'C1850.MP4');
  await fsp.copyFile(REAL_MOV, clip);

  const fps = await probeFramerate({ fullPath: clip, ext: '.MP4', sidecars: [] });
  assert.equal(fpsLabel(fps), '60fps');
});

test('an unreadable clip reports no frame rate rather than a wrong one', async () => {
  const dir = await tmpDir();
  const clip = path.join(dir, 'BROKEN.MP4');
  await fsp.writeFile(clip, 'not a video at all');

  assert.equal(await probeFramerate({ fullPath: clip, ext: '.MP4', sidecars: [] }), null);
  assert.equal(fpsLabel(null), null);
});

test('formats the parser cannot read fall back to the camera XML sidecar', async () => {
  const dir = await tmpDir();
  const xml = path.join(dir, 'C0041M01.XML');
  await fsp.writeFile(xml, `<?xml version="1.0"?>
    <NonRealTimeMeta>
      <VideoFormat>
        <VideoFrame videoCodec="AVC_3840_2160_HP@L51" captureFps="119.88p" formatFps="59.94p"/>
      </VideoFormat>
    </NonRealTimeMeta>`);

  const fps = await probeFramerate({
    fullPath: path.join(dir, 'C0041.MXF'),
    ext: '.MXF',
    sidecars: [{ fullPath: xml, kind: '.xml', ext: '.XML' }],
  });

  // captureFps is the rate the sensor ran at — the number that matters for
  // slow motion — so it wins over the 59.94p playback rate beside it.
  assert.equal(fpsLabel(fps), '120fps');
});

test('measured rates take the name people say out loud', () => {
  // NTSC rates and ordinary camera jitter both snap to the nominal rate.
  assert.equal(fpsLabel(119.88), '120fps');
  assert.equal(fpsLabel(23.976), '24fps');
  assert.equal(fpsLabel(29.97), '30fps');
  assert.equal(fpsLabel(59.94), '60fps');
  assert.equal(fpsLabel(239.76), '240fps');
  assert.equal(fpsLabel(60.0216), '60fps');
  assert.equal(fpsLabel(89.552), '90fps');

  // A genuinely unusual rate keeps its own number rather than being forced.
  assert.equal(fpsLabel(37.2), '37.2fps');
  assert.equal(fpsLabel(12), '12fps');

  // Nothing believable, nothing claimed.
  assert.equal(fpsLabel(0), null);
  assert.equal(fpsLabel(NaN), null);
  assert.equal(fpsLabel(9000), null);
});

test('a suffix this app already added is never stacked twice', () => {
  assert.equal(stripFpsSuffix('C1850_120fps'), 'C1850');
  assert.equal(stripFpsSuffix('Japan_1_23.98fps'), 'Japan_1');
  assert.equal(stripFpsSuffix('C1850'), 'C1850');
  // A clip that simply has "fps" in its name is left alone.
  assert.equal(stripFpsSuffix('highfps_test'), 'highfps_test');
});

test('attaching rates annotates every file, readable or not', async () => {
  const dir = await tmpDir();
  await fsp.copyFile(REAL_MOV, path.join(dir, 'GOOD.MP4'));
  await fsp.writeFile(path.join(dir, 'BAD.MP4'), 'nope');

  const files = [
    { fullPath: path.join(dir, 'GOOD.MP4'), ext: '.MP4', sidecars: [] },
    { fullPath: path.join(dir, 'BAD.MP4'), ext: '.MP4', sidecars: [] },
  ];

  await attachFramerates(files, { concurrency: 2 });

  assert.equal(files[0].fpsLabel, '60fps');
  assert.equal(files[1].framerate, null);
  assert.equal(files[1].fpsLabel, null);
});
