import { compareVersions, digest, fail, keys, plain, validVersion } from './common.js';

export const OFFICIAL_REPOSITORY = 'arctan303/FlareTune';
export const RELEASE_MANIFEST_NAME = 'flaretune-update.json';
export const SOURCE_ARCHIVE_NAME = 'flaretune-source.tar.gz';
export const releaseSourceUrl = (version, commit, channel) => channel === 'stable'
  ? `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/${version}/${SOURCE_ARCHIVE_NAME}`
  : `https://codeload.github.com/${OFFICIAL_REPOSITORY}/tar.gz/${commit}`;
const fields = ['schemaVersion', 'id', 'version', 'commit', 'host', 'hostApiVersion', 'minVersion', 'notes', 'source', 'migration', 'channel'];
export function validateRelease(value, { channel = 'stable' } = {}) {
  if (!keys(value, fields) || value.schemaVersion !== 1 || !validVersion(value.version)
    || !/^[a-f0-9]{40}$/.test(value.commit || '') || value.id !== `${value.version}:${value.commit}`
    || !keys(value.host, ['version', 'sourceDigest']) || value.host.version !== value.version || !digest(value.host.sourceDigest)
    || !Number.isSafeInteger(value.hostApiVersion) || value.hostApiVersion < 1 || value.hostApiVersion > 10000
    || !validVersion(value.minVersion) || compareVersions(value.minVersion, value.version) > 0
    || !keys(value.notes, ['zh', 'en']) || !['zh', 'en'].every(key => typeof value.notes[key] === 'string' && value.notes[key].length <= 16000)
    || !keys(value.source, ['url', 'sha256']) || !digest(value.source.sha256)
    || value.source.url !== releaseSourceUrl(value.version, value.commit, channel)
    || !keys(value.migration, ['compatible']) || value.migration.compatible !== true
    || value.channel !== channel || !['stable', 'candidate'].includes(channel)) fail('SYSTEM_UPDATE_RELEASE_INVALID', 502);
  return structuredClone(value);
}

export async function boundedJson(response, limit = 65536) {
  if (!response.ok || Number(response.headers.get('Content-Length')) > limit || !response.body) fail('SYSTEM_UPDATE_RELEASE_UNAVAILABLE', 502);
  const reader = response.body.getReader(); let size = 0, text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
      if (size > limit) { await reader.cancel(); fail('SYSTEM_UPDATE_RELEASE_INVALID', 502); } text += decoder.decode(item.value, { stream: true }); }
    return JSON.parse(text + decoder.decode());
  } catch (error) { if (error?.code?.startsWith('SYSTEM_UPDATE_')) throw error; fail('SYSTEM_UPDATE_RELEASE_INVALID', 502); }
  finally { reader.releaseLock(); }
}

export async function discoverRelease(env, { fetchImpl = fetch } = {}) {
  if (env.FLARETUNE_UPDATE_CANDIDATE_JSON !== undefined) {
    try {
      if (typeof env.FLARETUNE_UPDATE_CANDIDATE_JSON !== 'string'
        || new TextEncoder().encode(env.FLARETUNE_UPDATE_CANDIDATE_JSON).length > 65536) throw Error();
      return validateRelease(JSON.parse(env.FLARETUNE_UPDATE_CANDIDATE_JSON), { channel: 'candidate' });
    } catch { fail('SYSTEM_UPDATE_CANDIDATE_INVALID', 503); }
  }
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'FlareTune-System-Update' };
  let release;
  try { release = await boundedJson(await fetchImpl(`https://api.github.com/repos/${OFFICIAL_REPOSITORY}/releases/latest`,
    { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) })); }
  catch (error) { if (error?.code) throw error; fail('SYSTEM_UPDATE_RELEASE_UNAVAILABLE', 502); }
  if (!plain(release) || release.draft !== false || release.prerelease !== false || !validVersion(release.tag_name)
    || !Array.isArray(release.assets)) fail('SYSTEM_UPDATE_RELEASE_INVALID', 502);
  const wanted = `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/${release.tag_name}/${RELEASE_MANIFEST_NAME}`;
  const archive = releaseSourceUrl(release.tag_name, '', 'stable');
  if (release.assets.filter(asset => asset?.name === RELEASE_MANIFEST_NAME && asset.browser_download_url === wanted).length !== 1
    || release.assets.filter(asset => asset?.name === SOURCE_ARCHIVE_NAME && asset.browser_download_url === archive).length !== 1) {
    fail('SYSTEM_UPDATE_RELEASE_UNAVAILABLE', 502);
  }
  let manifest;
  try { manifest = await boundedJson(await fetchImpl(wanted, { headers: { Accept: 'application/json' },
    redirect: 'follow', signal: AbortSignal.timeout(15000) })); }
  catch (error) { if (error?.code) throw error; fail('SYSTEM_UPDATE_RELEASE_UNAVAILABLE', 502); }
  const valid = validateRelease(manifest);
  if (valid.version !== release.tag_name) fail('SYSTEM_UPDATE_RELEASE_INVALID', 502);
  return valid;
}
