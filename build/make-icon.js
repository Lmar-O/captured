'use strict';

/**
 * Build build/icon.icns from the source artwork.
 *
 * Source is build/icon-source.png if present, otherwise build/icon.svg.
 * macOS ships no SVG rasteriser and rsvg/ImageMagick are not dependencies
 * worth adding, so Electron — already here — does the drawing and
 * sips/iconutil cut the sizes.
 *
 * The artwork is normalised to Apple's icon grid on the way through: the
 * opaque body is scaled to 824px and centred in a 1024px canvas, the
 * proportions every stock macOS icon uses. Art drawn edge to edge otherwise
 * sits noticeably larger than its neighbours in the Dock. Pass --raw to skip
 * the normalisation and use the artwork exactly as supplied.
 *
 *   npx electron build/make-icon.js [--raw]
 */
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CANVAS = 1024;
const BODY = 824; // Apple's icon body within a 1024 canvas

const SIZES = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const raw = process.argv.includes('--raw');
  const pngSource = path.join(__dirname, 'icon-source.png');
  const svgSource = path.join(__dirname, 'icon.svg');

  let href;
  if (fs.existsSync(pngSource)) {
    href = `data:image/png;base64,${fs.readFileSync(pngSource).toString('base64')}`;
  } else {
    href = `data:image/svg+xml;base64,${fs.readFileSync(svgSource).toString('base64')}`;
  }

  const win = new BrowserWindow({
    width: CANVAS, height: CANVAS, show: false,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html,<body style="margin:0">');

  const result = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(href)};
    await img.decode();

    const w = img.naturalWidth || ${CANVAS};
    const h = img.naturalHeight || ${CANVAS};

    // Measure the opaque body, ignoring soft shadow at the edges.
    const probe = new OffscreenCanvas(w, h);
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(img, 0, 0, w, h);
    const { data } = pctx.getImageData(0, 0, w, h);

    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 200) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }

    const out = new OffscreenCanvas(${CANVAS}, ${CANVAS});
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';

    let info;
    if (${raw} || x1 < 0) {
      ctx.drawImage(img, 0, 0, ${CANVAS}, ${CANVAS});
      info = { normalised: false };
    } else {
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      // Uniform scale keyed to the larger axis so the body never exceeds 824.
      const scale = ${BODY} / Math.max(bw, bh);
      // Centre the body's midpoint on the canvas centre; the shadow rides
      // along into the surrounding margin, which is what it is there for.
      const dx = ${CANVAS} / 2 - (x0 + bw / 2) * scale;
      const dy = ${CANVAS} / 2 - (y0 + bh / 2) * scale;
      ctx.drawImage(img, dx, dy, w * scale, h * scale);
      info = {
        normalised: true,
        sourceBody: bw + 'x' + bh,
        sourcePct: ((Math.max(bw, bh) / w) * 100).toFixed(1),
        scale: scale.toFixed(4),
      };
    }

    const blob = await out.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    // Chunked: spreading a few hundred KB into fromCharCode blows the stack.
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    return { info, b64: btoa(s) };
  })()`);

  const master = path.join(__dirname, 'icon.png');
  fs.writeFileSync(master, Buffer.from(result.b64, 'base64'));

  const iconset = path.join(__dirname, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);

  for (const [size, name] of SIZES) {
    execFileSync('/usr/bin/sips', ['-z', String(size), String(size), master,
      '--out', path.join(iconset, name)], { stdio: 'ignore' });
  }

  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(__dirname, 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });

  console.log('wrote build/icon.icns', JSON.stringify(result.info));
  app.exit(0);
});
