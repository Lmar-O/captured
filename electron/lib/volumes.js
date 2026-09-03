'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

/**
 * List mounted volumes for the Source pane.
 *
 * diskutil is the only thing on macOS that reliably says whether a volume is
 * removable, which is what separates a card reader from the boot disk. Its
 * plist output goes through plutil rather than a plist parser dependency.
 */
async function listVolumes() {
  const mounts = new Set(['/']);

  try {
    for (const name of await fsp.readdir('/Volumes')) {
      if (name.startsWith('.')) continue;
      mounts.add(path.join('/Volumes', name));
    }
  } catch {
    // /Volumes is always present on macOS; if it is not, "/" alone is fine.
  }

  const volumes = [];
  for (const mount of mounts) {
    const info = await diskutilInfo(mount);
    if (!info) continue;

    // The boot volume shows up twice: once as "/" and once as a firmlinked
    // /Volumes entry pointing at the same device. Keep the "/" one.
    if (mount !== '/' && info.deviceIdentifier
        && volumes.some((v) => v.deviceIdentifier === info.deviceIdentifier)) {
      continue;
    }

    volumes.push({
      path: mount,
      name: info.name || path.basename(mount) || 'Macintosh HD',
      deviceIdentifier: info.deviceIdentifier,
      removable: info.removable,
      internal: info.internal,
      isBoot: mount === '/',
      totalBytes: info.totalBytes,
      freeBytes: info.freeBytes,
      hasDcim: await hasDcim(mount),
    });
  }

  // Cards first, then other externals, then the boot disk.
  volumes.sort((a, b) => {
    const rank = (v) => (v.hasDcim ? 0 : v.removable ? 1 : v.isBoot ? 3 : 2);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  return volumes;
}

async function diskutilInfo(mount) {
  try {
    const { stdout } = await run('/bin/sh', [
      '-c',
      `/usr/sbin/diskutil info -plist ${shellQuote(mount)} | /usr/bin/plutil -convert json -o - -`,
    ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });

    const info = JSON.parse(stdout);
    return {
      name: info.VolumeName,
      deviceIdentifier: info.DeviceIdentifier,
      // "Ejectable" is what a card reader reports; RemovableMedia covers
      // the card itself when the reader is built in.
      removable: Boolean(info.Ejectable || info.RemovableMedia || info.RemovableMediaOrExternalDevice),
      internal: Boolean(info.Internal),
      totalBytes: info.TotalSize ?? info.Size ?? null,
      freeBytes: info.FreeSpace ?? null,
    };
  } catch {
    // Network shares and disk images can fail diskutil; fall back to statfs
    // so they still appear as pickable sources.
    try {
      const stat = await fsp.statfs(mount);
      return {
        name: path.basename(mount) || 'Macintosh HD',
        deviceIdentifier: null,
        removable: false,
        internal: false,
        totalBytes: stat.blocks * stat.bsize,
        freeBytes: stat.bavail * stat.bsize,
      };
    } catch {
      return null;
    }
  }
}

/** A DCIM folder is the strongest signal that a volume is a camera card. */
async function hasDcim(mount) {
  try {
    const entries = await fsp.readdir(mount);
    return entries.some((e) => e.toUpperCase() === 'DCIM');
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = { listVolumes };
