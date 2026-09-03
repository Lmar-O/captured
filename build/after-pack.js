'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * Ad-hoc sign the packaged app.
 *
 * With `mac.identity: null` electron-builder skips signing altogether, which
 * leaves only the linker signature Electron ships with — its identifier is
 * literally "Electron" and `codesign --verify` fails on it. Apple Silicon
 * refuses to run a binary with a broken signature, so a downloaded build would
 * come up as "damaged" on any machine other than the one that built it.
 *
 * Signing with `-` produces a real, self-contained ad-hoc signature under the
 * app's own bundle id. That is not a substitute for a Developer ID — Gatekeeper
 * still warns on first launch — but the app runs, and the warning is the normal
 * "unidentified developer" one that right-click → Open clears.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // A universal build packs each arch into its own *-temp directory and then
  // merges them. @electron/universal requires every non-binary file to match
  // across the two slices, and signing them separately makes their
  // _CodeSignature/CodeResources diverge — the merge then fails outright.
  // Skip the slices and sign the merged app, which afterPack also visits.
  if (/-(x64|arm64)-temp\/?$/.test(context.appOutDir)) {
    console.log(`  • skipping ad-hoc signature on ${path.basename(context.appOutDir)} (universal slice)`);
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const appId = context.packager.appInfo.id;

  execFileSync('/usr/bin/codesign', [
    '--force', '--deep', '--sign', '-', '--identifier', appId, appPath,
  ], { stdio: 'inherit' });

  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });

  console.log(`  • ad-hoc signed ${appName} as ${appId}`);
};
