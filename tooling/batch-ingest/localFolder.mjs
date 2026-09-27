import { randomBytes } from 'node:crypto';
import { opendir, open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseFile, parseStream } from 'music-metadata';
import { AUDIO_TYPES, COVER_TYPES, validMediaSignature } from './core.mjs';

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
};
const token = () => randomBytes(16).toString('hex');
const LIMIT = 5000;

export class LocalFolder {
  constructor() { this.files = new Map(); this.root = ''; this.generation = 0; }
  invalidate() { this.generation += 1; this.files = new Map(); this.root = ''; }

  async scan(input) {
    this.invalidate();
    const generation = this.generation;
    if (typeof input !== 'string' || !input.trim() || input.length > 4096) throw new Error('请输入本机音乐目录的绝对路径。');
    if (!isAbsolute(input.trim())) throw new Error('请输入本机音乐目录的绝对路径。');
    const requested = resolve(input.trim());
    const root = await realpath(requested);
    if (!(await stat(root)).isDirectory()) throw new Error('所选路径不是文件夹。');
    const next = new Map();
    const files = [];
    const walk = async (directory, depth) => {
      if (depth > 24) throw new Error('目录层级超过 24 层，请选择更小的音乐目录。');
      const handle = await opendir(directory);
      for await (const item of handle) {
        if (generation !== this.generation) throw new Error('扫描已被新请求替代。');
        if (item.isSymbolicLink()) continue;
        const path = join(directory, item.name);
        if (item.isDirectory()) { await walk(path, depth + 1); continue; }
        if (!item.isFile()) continue;
        const extension = extname(item.name).slice(1).toLowerCase();
        if (!AUDIO_TYPES[extension]) continue;
        const info = await stat(path);
        if (!info.size) continue;
        if (files.length >= LIMIT) throw new Error(`单次最多扫描 ${LIMIT} 首音频，请选择更小的目录。`);
        let common = {}, duration = '';
        try {
          const data = await parseFile(path, { duration: true, skipCovers: false });
          common = data.common || {};
          duration = Number.isFinite(data.format?.duration) ? String(Math.round(data.format.duration)) : '';
        } catch { /* The filename remains available for manual editing. */ }
        const picture = common.picture?.find((image) => COVER_TYPES[(image.format || '').split('/')[1]]);
        const coverExtension = picture?.format?.split('/')[1] || '';
        const id = token();
        const name = basename(path);
        const relativePath = relative(root, path).replaceAll('\\', '/');
        next.set(id, { path, root, size: info.size, mtimeMs: info.mtimeMs,
          dev: info.dev, ino: info.ino, extension });
        files.push({ id, name, path: `${basename(root)}/${relativePath}`, size: info.size,
          lastModified: info.mtimeMs, common: { title: common.title || '', artist: common.artist || '',
            artists: common.artists || [], album: common.album || '', language: common.language || '' },
          duration, cover: coverExtension ? { name: `cover.${coverExtension}`, size: picture.data.length } : null });
      }
    };
    await walk(root, 0);
    if (generation !== this.generation) throw new Error('扫描已被新请求替代。');
    this.root = root;
    this.files = next;
    return { path: root, files };
  }

  async get(id) {
    const file = this.files.get(id);
    if (!file) throw new Error('本机文件引用已失效，请重新扫描目录。');
    const actual = await realpath(file.path);
    if (!inside(file.root, actual)) throw new Error('文件已移出扫描目录，请重新扫描。');
    const info = await stat(actual);
    if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs
      || info.dev !== file.dev || info.ino !== file.ino) {
      throw new Error('文件扫描后已变化，请重新扫描目录。');
    }
    return { ...file, path: actual };
  }

  async openAudio(id, { start = 0, end } = {}) {
    const file = await this.get(id);
    const handle = await open(file.path, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs
        || info.dev !== file.dev || info.ino !== file.ino) throw new Error('文件扫描后已变化，请重新扫描目录。');
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
          || info.dev !== file.dev || info.ino !== file.ino) throw new Error('文件扫描后已变化，请重新扫描目录。');
        const prefix = Buffer.alloc(16);
        await handle.read(prefix, 0, 16, 0);
        if (!validMediaSignature(prefix, file.extension)) throw new Error('音频格式与扩展名不匹配。');
        return { extension: file.extension, size: file.size,
          body: handle.createReadStream({ autoClose: true }) };
      } catch (error) { await handle.close(); throw error; }
    }
    if (kind !== 'cover') throw new Error('媒体类型不受支持。');
    const opened = await this.openAudio(id);
    const metadata = await parseStream(opened.body, { mimeType: AUDIO_TYPES[file.extension], size: file.size }, { skipCovers: false });
    const picture = metadata.common.picture?.find((image) => COVER_TYPES[(image.format || '').split('/')[1]]);
    if (!picture) throw new Error('此文件没有可用封面，请重新扫描。');
    const extension = picture.format.split('/')[1];
    if (!validMediaSignature(picture.data, extension)) throw new Error('封面格式无效。');
    return { extension, size: picture.data.length, body: picture.data };
  }
}
