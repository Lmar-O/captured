'use strict';

/**
 * Generate dev/preview.html from renderer/index.html so the Import screen can
 * be opened in a browser with the mock bridge. Derived rather than copied, so
 * the preview cannot drift from the real markup.
 *
 *   node dev/build-preview.js && open dev/preview.html
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

html = html
  .replace(/(href|src)="(?!https?:)/g, '$1="../renderer/')
  .replace('<script src="../renderer/icons.js">', '<script src="mock-api.js"></script>\n<script src="../renderer/icons.js">')
  // The CSP names 'self'; the preview loads from a sibling directory.
  .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/, '<!-- CSP relaxed for preview -->');

// Cache-bust local assets so a rebuild is always what the browser loads.
const stamp = Date.now();
html = html.replace(/(href|src)="(\.\.\/renderer\/[^"]+|mock-api\.js)"/g, `$1="$2?t=${stamp}"`);

fs.writeFileSync(path.join(__dirname, 'preview.html'), html);
console.log('wrote dev/preview.html');
