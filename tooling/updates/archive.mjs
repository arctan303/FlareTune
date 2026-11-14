import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { readBoundedResponse } from '../plugins/assemble.mjs';
import { validateRelease } from '../../server/src/systemUpdate/releases.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
export const SOURCE_LIMITS = Object.freeze({ compressed: 64 * 1024 * 1024, expanded: 256 * 1024 * 1024,
  file: 32 * 1024 * 1024, entries: 15000 });
const text = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('SYSTEM_UPDATE_ARCHIVE_INVALID'); } };
const field = bytes => text(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
function octal(bytes) {
  const value = field(bytes).trim();
  if (!/^[0-7]+$/.test(value || '0')) fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
  const number = Number.parseInt(value || '0', 8);
  if (!Number.isSafeInteger(number) || number < 0) fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
  return number;
}
function pax(bytes) {
  const result = {}; let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < offset || space - offset > 10) fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
    const length = Number(lengthText), end = offset + length;
    if (length < space - offset + 4 || end > bytes.length || bytes[end - 1] !== 10) fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
    const record = text(bytes.subarray(space + 1, end - 1)), equals = record.indexOf('=');
    if (equals < 1) fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
    const key = record.slice(0, equals);
    if (!['path', 'mtime', 'atime', 'ctime', 'comment'].includes(key) || Object.hasOwn(result, key)) fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
    result[key] = record.slice(equals + 1); offset = end;
  }
  return result;
}
function safePath(name, prefix) {
  if (typeof name !== 'string' || name.length > 600 || /[\\:\u0000-\u001f\u007f]/.test(name) || name.startsWith('/')) fail('SYSTEM_UPDATE_ARCHIVE_PATH_INVALID');
  const segments = name.replace(/\/$/, '').split('/');
  if (segments[0] !== prefix || segments.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('SYSTEM_UPDATE_ARCHIVE_PATH_INVALID');
  return segments.slice(1).join('/');
}

// Parse all headers before writing. Only ordinary files/directories are accepted;
// no symlinks, hard links, devices, sparse files or executable archive commands.
export function inspectSourceArchive(compressed, commit, limits = SOURCE_LIMITS) {
  if (!/^[a-f0-9]{40}$/.test(commit || '') || !Buffer.isBuffer(compressed) || compressed.length > limits.compressed) fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
  let bytes;
  try { bytes = gunzipSync(compressed, { maxOutputLength: limits.expanded }); }
  catch { fail('SYSTEM_UPDATE_ARCHIVE_TOO_LARGE_OR_INVALID'); }
  const prefix = `FlareTune-${commit}`, entries = [], names = new Set();
  let offset = 0, extended = null, ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (bytes.subarray(offset).some(byte => byte !== 0)) fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
      ended = true; break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (octal(header.subarray(148, 156)) !== sum) fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
    const size = octal(header.subarray(124, 136)), type = String.fromCharCode(header[156] || 48);
    if (size > limits.file || offset + size > bytes.length) fail('SYSTEM_UPDATE_ARCHIVE_TOO_LARGE_OR_INVALID');
    const data = bytes.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    if (type === 'g' || type === 'x') {
      const metadata = pax(data);
      if (type === 'g') { if (metadata.path || extended) fail('SYSTEM_UPDATE_ARCHIVE_INVALID'); }
      else { if (extended) fail('SYSTEM_UPDATE_ARCHIVE_INVALID'); extended = metadata; }
      continue;
    }
    if (!['0', '5'].includes(type) || field(header.subarray(157, 257))) fail('SYSTEM_UPDATE_ARCHIVE_LINK_UNSUPPORTED');
    const headerPrefix = field(header.subarray(345, 500));
    const name = extended?.path || `${headerPrefix ? headerPrefix + '/' : ''}${field(header.subarray(0, 100))}`;
    extended = null;
    const path = safePath(name, prefix);
    if (type === '5' && size !== 0 || !path && type !== '5') fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
    if (!path) continue;
    const key = path.toLowerCase();
    if (names.has(key) || entries.length >= limits.entries) fail('SYSTEM_UPDATE_ARCHIVE_PATH_INVALID');
    names.add(key); entries.push({ path, directory: type === '5', data });
  }
  if (!ended || extended || !entries.some(entry => entry.path === 'package.json' && !entry.directory)) fail('SYSTEM_UPDATE_ARCHIVE_INVALID');
  const fileNames = new Set(entries.filter(entry => !entry.directory).map(entry => entry.path.toLowerCase()));
  for (const entry of entries) {
    const parts = entry.path.toLowerCase().split('/'); parts.pop();
    while (parts.length) { if (fileNames.has(parts.join('/'))) fail('SYSTEM_UPDATE_ARCHIVE_PATH_INVALID'); parts.pop(); }
  }
  return entries;
}

export async function downloadSource(target, { fetchImpl = fetch, limits = SOURCE_LIMITS } = {}) {
  let release;
  try { release = validateRelease(target, { channel: target?.channel }); }
  catch { fail('SYSTEM_UPDATE_SOURCE_INVALID'); }
  const signal = AbortSignal.timeout(60000), stable = release.channel === 'stable';
  let url = release.source.url, response;
  for (let redirects = 0; ; redirects++) {
    try { response = await fetchImpl(url, { redirect: stable ? 'manual' : 'error', credentials: 'omit', signal,
      headers: { Accept: 'application/gzip' } }); }
    catch { fail('SYSTEM_UPDATE_SOURCE_DOWNLOAD_FAILED'); }
    if (response.redirected) { await response.body?.cancel().catch(() => {}); fail('SYSTEM_UPDATE_SOURCE_REDIRECT_INVALID'); }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel().catch(() => {});
    if (!stable || redirects >= 3) fail('SYSTEM_UPDATE_SOURCE_REDIRECT_INVALID');
    const location = response.headers.get('Location');
    if (!location || /[\s\\\u0000-\u001f\u007f]/.test(location)) fail('SYSTEM_UPDATE_SOURCE_REDIRECT_INVALID');
    let next;
    try { next = new URL(location, url); } catch { fail('SYSTEM_UPDATE_SOURCE_REDIRECT_INVALID'); }
    // The initial GitHub release asset URL is fixed by validateRelease. Follow
    // only its known public release-asset CDN, never arbitrary redirects or a
    // githubusercontent.com wildcard. Signed CDN query strings are not logged.
    if (next.protocol !== 'https:' || next.hostname !== 'release-assets.githubusercontent.com' || next.port
      || next.username || next.password || next.hash) fail('SYSTEM_UPDATE_SOURCE_REDIRECT_INVALID');
    url = next.href;
  }
  const bytes = await readBoundedResponse(response, limits.compressed, 'SYSTEM_UPDATE_SOURCE_DOWNLOAD_FAILED');
  if (createHash('sha256').update(bytes).digest('hex') !== release.source.sha256) fail('SYSTEM_UPDATE_SOURCE_DIGEST_MISMATCH');
  return bytes;
}

export async function extractSourceArchive(bytes, commit, directory, { limits = SOURCE_LIMITS } = {}) {
  const entries = inspectSourceArchive(bytes, commit, limits);
  const root = await realpath(directory);
  if ((await readdir(root)).length) fail('SYSTEM_UPDATE_EXTRACTION_NOT_EMPTY');
  for (const entry of entries) {
    const path = resolve(root, entry.path), rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('SYSTEM_UPDATE_ARCHIVE_PATH_INVALID');
    if (entry.directory) await mkdir(path, { recursive: true });
    else {
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, entry.data, { flag: 'wx', mode: 0o600 });
    }
  }
  return root;
}
