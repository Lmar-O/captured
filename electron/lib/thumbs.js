'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

/**
 * Video thumbnails via QuickLook.
 *
 * qlmanage is the same generator Finder uses, so it handles every codec the
 * Mac already previews — MP4, MOV, BRAW and the rest — with nothing to
 * install. Results are cached on disk by path + size + mtime, so re-scanning
 * a card is instant and only genuinely new clips cost a render.
 */
class ThumbnailCache {
  constructor(cacheDir, { concurrency = 3, size = 640 } = {}) {
    this.cacheDir = cacheDir;
    this.size = size;
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.inFlight = new Map();
    this.ready = fsp.mkdir(cacheDir, { recursive: true });
  }

  key(file) {
    return crypto
      .createHash('sha1')
      .update(`${file.fullPath}\0${file.size}\0${Math.round(file.mtimeMs)}\0${this.size}`)
      .digest('hex');
  }

  /** Cached PNG path, or null if this clip has no preview yet. */
  async get(file) {
    await this.ready;
    const target = path.join(this.cacheDir, `${this.key(file)}.png`);
    try {
      await fsp.access(target);
      return target;
    } catch {
      return null;
    }
  }

  /**
   * Render a thumbnail, reusing the cache and coalescing duplicate requests
   * for the same clip. Resolves to a PNG path, or null when QuickLook has
   * nothing to offer — the caller falls back to a placeholder.
   */
  async request(file) {
    await this.ready;
    const cached = await this.get(file);
    if (cached) return cached;

    const key = this.key(file);
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const job = new Promise((resolve) => {
      this.queue.push({ file, key, resolve });
      this.pump();
    }).finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, job);
    return job;
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      this.render(job.file, job.key)
        .then(job.resolve, () => job.resolve(null))
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  async render(file, key) {
    const target = path.join(this.cacheDir, `${key}.png`);

    // qlmanage names its output after the source file and refuses to
    // overwrite, so each render gets a scratch directory of its own.
    const workDir = path.join(this.cacheDir, `.work-${key}`);
    await fsp.mkdir(workDir, { recursive: true });

    try {
      await execFileAsync('/usr/bin/qlmanage', [
        '-t', '-s', String(this.size), '-o', workDir, file.fullPath,
      ], { timeout: 20000 });

      const produced = (await fsp.readdir(workDir)).find((n) => n.endsWith('.png'));
      if (!produced) return null;

      await fsp.rename(path.join(workDir, produced), target);
      return target;
    } catch {
      return null;
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Drop queued work when the user switches cards mid-scan. */
  clearQueue() {
    for (const job of this.queue.splice(0)) job.resolve(null);
  }
}

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

module.exports = { ThumbnailCache };
