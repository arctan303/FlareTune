import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricsWorkspaceApi, lyricsWorkspaceApi, clampLyricOffset, LYRIC_OFFSET_MIN, LYRIC_OFFSET_MAX } from './localLyricsWorkspaceApi.js';
import { bindLyricsWorkspaceHost } from '../plugins/lyrics-workbench/api.js';
function fixture(role = 'admin') {
  const calls = []; const state = { current: true, ai: true };
  const host = { isCurrent: () => state.current, session: { get: () => ({ authenticated: true, user: { role } }) },
    features: { isAvailable: () => state.ai }, request: async (path, init) => { calls.push({ path, init }); return { ok: true, data: {} }; } };
  return { host, state, calls, api: createLyricsWorkspaceApi(host) };
}
test('administrator workspace API encodes source ids and forwards only permitted document fields', async () => {
  const f = fixture();
  await f.api.getLyrics('yt:abcdefghijk');
  await f.api.updateLyrics('song / 1', { source: 'lrclib', providerLyricId: 'one', ignored: 'private', etag: 'old' });
  await f.api.saveLyricsDocument('s1', { lines: [{ text: 'Saved' }], etag: 'one', aiReceipt: 'receipt', translationLanguage: 'en' });
  assert.equal(f.calls[0].path, 'workspace/yt%3Aabcdefghijk');
  assert.equal(f.calls[1].path, 'workspace/song%20%2F%201');
  assert.deepEqual(f.calls[1].init.body, { source: 'lrclib', providerLyricId: 'one', etag: 'old' });
  assert.equal(f.calls[2].init.body.aiReceipt, 'receipt');
});
test('members inspect and request permitted AI but cannot write shared lyrics or draft AI', async () => {
  const f = fixture('member');
  await f.api.getLyrics('s1'); await f.api.inspectLyricsCandidates('s1', []); await f.api.completeLyricsTranslation('s1');
  for (const action of [() => f.api.updateLyrics('s1', { source: 'lrclib' }), () => f.api.resetLyrics('s1'),
    () => f.api.completeDraftLyrics('s1', { lines: [], etag: 'one' })]) await assert.rejects(action, { status: 403 });
  assert.equal(f.calls.length, 3);
});
test('optional Gateway blocks only AI, preserving ordinary editing and candidates', async () => {
  const f = fixture(); f.state.ai = false;
  await f.api.getLyrics('s1'); await f.api.updateLyricsOffset('s1', { offsetMs: 1 });
  await assert.rejects(f.api.completeLyricsTranslation('s1'), { code: 'PLUGIN_DEPENDENCY_UNAVAILABLE' });
  await assert.rejects(f.api.completeDraftLyrics('s1', { lines: [], etag: 'one' }), { code: 'PLUGIN_DEPENDENCY_UNAVAILABLE' });
  assert.equal(f.calls.length, 2);
});
test('candidate filters and cancellation reach the plugin request without implicit AI', async () => {
  const f = fixture(); const controller = new AbortController();
  await f.api.getLyricsCandidates('s1', { title: 'Song', source: 'custom_lrc', signal: controller.signal });
  await f.api.updateLyrics('s1', { source: 'lrclib', providerLyricId: 'one' });
  assert.deepEqual(f.calls[0].init.query, { title: 'Song', source: 'custom_lrc' });
  assert.equal(f.calls[0].init.signal, controller.signal);
  assert.equal(f.calls.length, 2);
});
test('offset clamp remains integer finite and bounded', () => {
  assert.equal(clampLyricOffset(-9000), LYRIC_OFFSET_MIN); assert.equal(clampLyricOffset(9000), LYRIC_OFFSET_MAX);
  assert.equal(clampLyricOffset('149.6'), 150); assert.equal(clampLyricOffset(NaN), 0);
});
test('plugin errors preserve conflict status/code/data instead of claiming submission', async () => {
  const f = fixture(); f.host.request = async () => { throw Object.assign(new Error('Conflict'), { status: 409, code: 'LYRIC_ASSET_CONFLICT', data: { etag: 'new' } }); };
  await assert.rejects(f.api.resetLyrics('s1'), error => error.status === 409 && error.code === 'LYRIC_ASSET_CONFLICT' && error.data.etag === 'new');
});
test('a retired host rejects requests and a response that completed after retirement', async () => {
  const f = fixture(); let finish;
  f.host.request = () => new Promise(resolve => { finish = resolve; });
  const request = f.api.getLyrics('s1'); f.state.current = false; finish({ ok: true, data: { private: 'old' } });
  await assert.rejects(request, { status: 409 }); await assert.rejects(f.api.getLyrics('s1'), { status: 409 });
});
test('legacy player client is bound only to the active plugin runtime and cleanup cannot retire a replacement', async () => {
  const first = fixture(), second = fixture();
  const retireFirst = bindLyricsWorkspaceHost(first.host); await lyricsWorkspaceApi.getLyrics('s1');
  const retireSecond = bindLyricsWorkspaceHost(second.host); retireFirst(); await lyricsWorkspaceApi.getLyrics('s2');
  assert.equal(first.calls.length, 1); assert.equal(second.calls.length, 1);
  retireSecond(); await assert.rejects(lyricsWorkspaceApi.getLyrics('s1'), { status: 409 });
});
