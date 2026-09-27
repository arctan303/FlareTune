import { compareSongIdentity, normalizeSongIdentityText } from '../../client/src/utils/songDuplicateCheck.js';
import { catalogSongBody } from '../../client/src/utils/catalogSongDraft.js';
export { catalogSaveApplied } from '../../client/src/utils/catalogSaveVerification.js';

export const AUDIO_TYPES = Object.freeze({
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', wma: 'audio/x-ms-wma',
});
export const COVER_TYPES = Object.freeze({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
export const WORKER_MAX_BYTES = 100_000_000;

export function targetUrl(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('实例地址须为 HTTPS 根地址（本机测试可用 HTTP）。');
  }
  return url.origin;
}

export function mediaType(kind, extension) {
  const type = (kind === 'audio' ? AUDIO_TYPES : kind === 'cover' ? COVER_TYPES : {})[extension];
  if (!type) throw new Error('媒体类型不受支持。');
  return type;
}

export function validMediaSignature(bytes, extension) {
  const starts = (prefix) => prefix.every((byte, index) => bytes[index] === byte);
  if (extension === 'jpg' || extension === 'jpeg') return starts([0xff, 0xd8, 0xff]);
  if (extension === 'png') return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ascii = (start, end) => Buffer.from(bytes.subarray(start, end)).toString('ascii');
  if (extension === 'webp') return starts([0x52, 0x49, 0x46, 0x46]) && ascii(8, 12) === 'WEBP';
  if (extension === 'flac') return ascii(0, 4) === 'fLaC';
  if (extension === 'wav') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  if (extension === 'ogg') return ascii(0, 4) === 'OggS';
  if (extension === 'm4a') return ascii(4, 8) === 'ftyp';
  if (extension === 'aac') return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (extension === 'wma') return starts([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]);
  if (extension === 'mp3') {
    if (starts([0x49, 0x44, 0x33])) return true;
    const version = (bytes[1] >> 3) & 0x03;
    const layer = (bytes[1] >> 1) & 0x03;
    const bitrate = bytes[2] >> 4;
    const sampleRate = (bytes[2] >> 2) & 0x03;
    return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
      && version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && sampleRate !== 3;
  }
  return false;
}

export function folderLanguage(relativePath, mappings = {}) {
  const parts = String(relativePath || '').replaceAll('\\', '/').split('/');
  if (parts.length < 3) return '';
  const code = parts[1].toLowerCase();
  return mappings[code] ?? ({ zh: 'zh', en: 'en', jp: 'ja', ja: 'ja', ko: 'ko', yue: 'yue' }[code] || '');
}

export function duplicateMatches(candidate, catalog, prior) {
  return [
    ...prior.flatMap((song) => {
      const strength = compareSongIdentity(candidate, song);
      return strength ? [{ source: 'batch', strength, song }] : [];
    }),
    ...catalog.flatMap((song) => {
      const strength = compareSongIdentity(candidate, song);
      return strength ? [{ source: 'catalog', strength, song }] : [];
    }),
  ];
}

export function catalogDuplicateMatches(songs) {
  const byTitle = new Map();
  const matches = new Map();
  for (const song of songs) {
    const title = normalizeSongIdentityText(song.title);
    if (!title) continue;
    const earlier = byTitle.get(title) || [];
    for (const other of earlier) {
      const strength = compareSongIdentity(song, other);
      if (!strength) continue;
      if (!matches.has(song.id)) matches.set(song.id, []);
      if (!matches.has(other.id)) matches.set(other.id, []);
      matches.get(song.id).push({ song: other, strength });
      matches.get(other.id).push({ song, strength });
    }
    earlier.push(song);
    byTitle.set(title, earlier);
  }
  return matches;
}

export function replacementSongBody(draft, target, { audioUrl, coverUrl, hasNewCover }) {
  return { ...catalogSongBody({ ...draft, cover_url: hasNewCover ? coverUrl : target.cover_url }, false),
    audio_url: audioUrl, expectedVersion: target.version };
}

export function fileIdentity(baseUrl, file) {
  if (file.localRoot) return [baseUrl, 'node', file.localRoot, file.webkitRelativePath || file.name,
    file.size, file.lastModified].join('|');
  return [baseUrl, file.webkitRelativePath || file.name, file.size, file.lastModified].join('|');
}
