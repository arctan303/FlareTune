import { createHash } from 'node:crypto';
import { opendir, open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseFile, parseStream } from 'music-metadata';
import { AUDIO_TYPES, COVER_TYPES, validMediaSignature } from './core.mjs';

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
};
const fileId = (root, relativePath, info) => createHash('sha256')
  .update(JSON.stringify([root, relativePath, info.size, info.mtimeMs, info.dev, info.ino]))
  .digest('hex').slice(0, 32);
const LIMIT = 5000;

export class LocalFolder {
  constructor() { this.files = new Map(); this.root = ''; this.generation = 0; }
  invalidate() { this.generation += 1; this.files = new Map(); this.root = ''; }

  async scan(input) {
    this.invalidate();
    const generation = this.generation;
    if (typeof input !== 'string' || !input.trim() || input.length > 4096) throw new Error('Enter an absolute path to a local music folder.');
    if (!isAbsolute(input.trim())) throw new Error('Enter an absolute path to a local music folder.');
    const requested = resolve(input.trim());
    const root = await realpath(requested);
    if (!(await stat(root)).isDirectory()) throw new Error('The selected path is not a folder.');
    const next = new Map();
    const files = [];
    const walk = async (directory, depth) => {
      if (depth > 24) throw new Error('The folder is more than 24 levels deep. Select a smaller music folder.');
      const handle = await opendir(directory);
      for await (const item of handle) {
        if (generation !== this.generation) throw new Error('A newer request replaced this scan.');
        if (item.isSymbolicLink()) continue;
        const path = join(directory, item.name);
        if (item.isDirectory()) { await walk(path, depth + 1); continue; }
        if (!item.isFile()) continue;
        const extension = extname(item.name).slice(1).toLowerCase();
        if (!AUDIO_TYPES[extension]) continue;
        const info = await stat(path);
        if (!info.size) continue;
        if (files.length >= LIMIT) throw new Error(`A single scan supports at most ${LIMIT} audio files. Select a smaller folder.`);
        let common = {}, duration = '';
        try {
          const data = await parseFile(path, { duration: true, skipCovers: false });
          common = data.common || {};
          duration = Number.isFinite(data.format?.duration) ? String(Math.round(data.format.duration)) : '';
        } catch { /* The filename remains available for manual editing. */ }
        const picture = common.picture?.find((image) => COVER_TYPES[(image.format || '').split('/')[1]]);
        const coverExtension = picture?.format?.split('/')[1] || '';
        const name = basename(path);
        const relativePath = relative(root, path).replaceAll('\\', '/');
        const id = fileId(root, relativePath, info);
        next.set(id, { path, root, size: info.size, mtimeMs: info.mtimeMs,
          dev: info.dev, ino: info.ino, extension });
        files.push({ id, name, path: `${basename(root)}/${relativePath}`, size: info.size,
          lastModified: info.mtimeMs, common: { title: common.title || '', artist: common.artist || '',
            artists: common.artists || [], album: common.album || '', language: common.language || '' },
          duration, cover: coverExtension ? { name: `cover.${coverExtension}`, size: picture.data.length } : null });
      }
    };
    await walk(root, 0);
    if (generation !== this.generation) throw new Error('A newer request replaced this scan.');
    this.root = root;
    this.files = next;
    return { path: root, files };
  }

  async get(id) {
    const file = this.files.get(id);
    if (!file) throw new Error('The local file reference has expired. Rescan the folder.');
    const actual = await realpath(file.path);
    if (!inside(file.root, actual)) throw new Error('The file moved outside the scanned folder. Scan again.');
    const info = await stat(actual);
    if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs
      || info.dev !== file.dev || info.ino !== file.ino) {
      throw new Error('The file changed after scanning. Scan the folder again.');
    }
    return { ...file, path: actual };
  }

  async openAudio(id, { start = 0, end } = {}) {
    const file = await this.get(id);
    const handle = await open(file.path, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs
        || info.dev !== file.dev || info.ino !== file.ino) throw new Error('The file changed after scanning. Scan the folder again.');
      return { ...file, body: handle.createReadStream({ start, end, autoClose: true }) };
    } catch (error) { await handle.close(); throw error; }
  }

  async media(id, kind) {
    const file = await this.get(id);
    if (kind === 'audio') {
      const handle = await open(file.path, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs
          || info.dev !== file.dev || info.ino !== file.ino) throw new Error('The file changed after scanning. Scan the folder again.');
        const prefix = Buffer.alloc(16);
        await handle.read(prefix, 0, 16, 0);
        if (!validMediaSignature(prefix, file.extension)) throw new Error('The audio format does not match its file extension.');
        return { extension: file.extension, size: file.size,
          body: handle.createReadStream({ autoClose: true }) };
      } catch (error) { await handle.close(); throw error; }
    }
    if (kind !== 'cover') throw new Error('Unsupported media type.');
    const opened = await this.openAudio(id);
    try {
      const metadata = await parseStream(opened.body, { mimeType: AUDIO_TYPES[file.extension], size: file.size }, { skipCovers: false });
      const picture = metadata.common.picture?.find((image) => COVER_TYPES[(image.format || '').split('/')[1]]);
      if (!picture) throw new Error('This file has no usable cover art. Scan again.');
      const extension = picture.format.split('/')[1];
      if (!validMediaSignature(picture.data, extension)) throw new Error('Invalid cover art format.');
      return { extension, size: picture.data.byteLength, body: picture.data };
    } finally {
      opened.body.destroy();
    }
  }
}
