import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LYRIC_OFFSET_MAX, LYRIC_OFFSET_MIN, clampLyricOffset, lyricsWorkspaceApi,
} from './localLyricsWorkspaceApi.js';
import { useUIStore } from '../store/useUIStore.js';

function setSession(role = 'admin', csrfToken = 'local-csrf') {
  useUIStore.setState({ authSession: {
    authenticated: true, initialized: true,
    user: { accountId: `local-${role}`, role }, csrfToken,
  } });
}

const okResponse = (data = {}) => ({
  ok: true, status: 200, json: async () => ({ ok: true, data }),
});

test('administrator lyrics requests use only the local workspace endpoint family', async () => {
  setSession();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return okResponse();
  };
  try {
    await lyricsWorkspaceApi.getLyrics('song / 1');
    await lyricsWorkspaceApi.getLyricsCandidates('song / 1');
    await lyricsWorkspaceApi.inspectLyricsCandidates('song / 1', [{ source: 'kugou', providerLyricId: 'candidate-7' }]);
    await lyricsWorkspaceApi.updateLyrics('song / 1', {
      source: 'kugou', providerLyricId: 'candidate-7', etag: 'etag-1',
      ignored: 'must not leave the browser',
    });
    await lyricsWorkspaceApi.updateLyricsOffset('song / 1', { offsetMs: -150, etag: 'etag-2' });
    await lyricsWorkspaceApi.resetLyrics('song / 1', 'etag-3');
    await lyricsWorkspaceApi.completeLyricsTranslation('song / 1');
    await lyricsWorkspaceApi.clearLyricsTranslation('song / 1', 'etag-4');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 8);
  assert.match(calls[0].url, /\/api\/lyrics\/workspace\/song%20%2F%201$/);
  assert.match(calls[1].url, /\/candidates$/);
  assert.match(calls[2].url, /\/candidates\/inspect$/);
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    candidates: [{ source: 'kugou', providerLyricId: 'candidate-7' }],
  });
  assert.deepEqual(JSON.parse(calls[3].init.body), {
    source: 'kugou', providerLyricId: 'candidate-7', etag: 'etag-1',
  });
  assert.deepEqual(JSON.parse(calls[4].init.body), { offsetMs: -150, etag: 'etag-2' });
  assert.deepEqual(JSON.parse(calls[5].init.body), { etag: 'etag-3' });
  assert.deepEqual(JSON.parse(calls[6].init.body), {});
  assert.deepEqual(JSON.parse(calls[7].init.body), { etag: 'etag-4' });
  for (const call of calls) {
    assert.equal(call.init.credentials, 'include');
    assert.equal(call.init.headers['X-FlareTune-Expected-Account'], 'local-admin');
    assert.equal(call.init.headers['x-admin-api-key'], undefined);
    assert.equal(call.init.headers['X-Arc-CSRF'], undefined);
  }
  for (const call of calls.slice(2)) {
    assert.equal(call.init.headers['X-Requested-With'], 'FlareTune');
    assert.equal(call.init.headers['X-CSRF-Token'], 'local-csrf');
  }
});

test('member may inspect candidates and trigger AI, but cannot edit shared lyrics directly', async () => {
  setSession('member');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return okResponse();
  };
  try {
    await lyricsWorkspaceApi.getLyrics('s1');
    await lyricsWorkspaceApi.getLyricsCandidates('s1', { title: 'Custom Title', artist: 'Custom Artist' });
    await lyricsWorkspaceApi.inspectLyricsCandidates('s1', [{ source: 'kugou', providerLyricId: 'k1' }], {
      title: 'Custom Title', artist: 'Custom Artist',
    });
    await lyricsWorkspaceApi.completeLyricsTranslation('s1');
    for (const operation of [
      () => lyricsWorkspaceApi.updateLyrics('s1', { source: 'auto', etag: null }),
      () => lyricsWorkspaceApi.updateLyricsOffset('s1', { offsetMs: 1, etag: 'e' }),
      () => lyricsWorkspaceApi.resetLyrics('s1', 'e'),
      () => lyricsWorkspaceApi.clearLyricsTranslation('s1', 'e'),
    ]) await assert.rejects(operation(), { status: 403, code: 'FORBIDDEN' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 4);
  assert.match(calls[1].url, /\/candidates\?title=Custom\+Title&artist=Custom\+Artist$/);
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    candidates: [{ source: 'kugou', providerLyricId: 'k1' }],
    searchTitle: 'Custom Title', searchArtist: 'Custom Artist',
  });
  assert.deepEqual(JSON.parse(calls[3].init.body), {});
});

test('candidate adoption does not implicitly request AI completion and offset is clamped', async () => {
  setSession();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return okResponse();
  };
  try {
    await lyricsWorkspaceApi.updateLyrics('s1', {
      source: 'lrclib', providerLyricId: 'l1', searchTitle: 'Title', searchArtist: 'Artist',
    });
    await lyricsWorkspaceApi.updateLyricsOffset('s1', { offsetMs: 9000 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    source: 'lrclib', providerLyricId: 'l1', etag: null,
    searchTitle: 'Title', searchArtist: 'Artist',
  });
  assert.deepEqual(JSON.parse(calls[1].init.body), { offsetMs: 5000, etag: null });
});

test('offset clamp remains integer, finite and bounded', () => {
  assert.equal(clampLyricOffset(-9000), LYRIC_OFFSET_MIN);
  assert.equal(clampLyricOffset(9000), LYRIC_OFFSET_MAX);
  assert.equal(clampLyricOffset('149.6'), 150);
  assert.equal(clampLyricOffset(Number.NaN), 0);
});

test('lyrics conflict preserves status, code and current asset data', async () => {
  setSession();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 409,
    json: async () => ({ ok: false, error: 'LYRIC_ASSET_CONFLICT',
      message: 'stale asset', data: { etag: 'new' } }),
  });
  try {
    await assert.rejects(lyricsWorkspaceApi.updateLyricsOffset('s1', { offsetMs: 0, etag: 'old' }),
      (error) => error.status === 409 && error.code === 'LYRIC_ASSET_CONFLICT'
        && error.data?.etag === 'new');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI completion POST failure rejects instead of reporting a submitted job', async () => {
  setSession();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 503,
    json: async () => ({ ok: false, error: 'LYRIC_WORKSPACE_UNAVAILABLE', message: 'AI request failed' }),
  });
  try {
    await assert.rejects(lyricsWorkspaceApi.completeLyricsTranslation('s1'),
      (error) => error.status === 503 && error.code === 'LYRIC_WORKSPACE_UNAVAILABLE');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lyric mutations fail closed without a local CSRF token', async () => {
  setSession('admin', null);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('fetch should not run'); };
  try {
    await assert.rejects(lyricsWorkspaceApi.resetLyrics('s1'), {
      status: 401, code: 'UNAUTHORIZED',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
