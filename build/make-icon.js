'use strict';

/**
 * Rasterise build/icon.svg into build/icon.icns.
 *
 * macOS ships no SVG rasteriser and the usual ones (rsvg, ImageMagick) are not
 * dependencies worth adding, so Electron — already here — renders the artwork
 * and sips/iconutil do the rest.
 *
 *   npx electron build/make-icon.js
 */
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SIZES = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`,
  ));
  // Let the gradients paint before grabbing the frame.
  await new Promise((r) => setTimeout(r, 600));

  const image = await win.webContents.capturePage();
  const master = path.join(__dirname, 'icon.png');
  fs.writeFileSync(master, image.toPNG());

  const iconset = path.join(__dirname, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);

  // capturePage returns device pixels, so normalise to 1024 before scaling down.
  execFileSync('/usr/bin/sips', ['-z', '1024', '1024', master, '--out', master], { stdio: 'ignore' });

  for (const [size, name] of SIZES) {
    execFileSync('/usr/bin/sips', ['-z', String(size), String(size), master,
      '--out', path.join(iconset, name)], { stdio: 'ignore' });
  }

  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(__dirname, 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });

  console.log('wrote build/icon.icns');
  app.exit(0);
});
