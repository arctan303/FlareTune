import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountPlayStatsRequestError,
  fetchAccountPlayStats,
  submitAccountPlayStats,
} from './accountPlayStats.js';
import { useUIStore } from '../store/useUIStore.js';

test('accountPlayStats client: fetchAccountPlayStats queries play-stats endpoint', async () => {
  let requestedUrl = null;
  let requestedInit = null;
  const mockFetch = async (url, init) => {
    requestedUrl = url;
    requestedInit = init;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        songs: [{ id: 's1', title: 'Song 1', play_count: 5 }],
        totalPlays: 5,
        totalUniqueSongs: 1,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const data = await fetchAccountPlayStats({
    limit: 10,
    expectedSubject: 'account-a',
    fetchImpl: mockFetch,
    apiBase: 'https://test-api.example.com',
  });

  assert.equal(requestedUrl, 'https://test-api.example.com/api/account/play-stats?limit=10');
  assert.equal(requestedInit.credentials, 'include');
  assert.equal(requestedInit.headers['X-FlareTune-Expected-Account'], 'account-a');
  assert.equal(data.songs.length, 1);
  assert.equal(data.totalPlays, 5);
});

test('accountPlayStats client: submitAccountPlayStats sends idempotent events with CSRF and keepalive', async () => {
  useUIStore.setState((state) => ({ authSession: { ...state.authSession, csrfToken: 'local-csrf-test' } }));
  let requestedUrl = null;
  let requestedInit = null;
  const mockFetch = async (url, init) => {
    requestedUrl = url;
    requestedInit = init;
    return new Response(JSON.stringify({
      ok: true,
      data: { recorded: 2, acceptedEventIds: ['event_1', 'event_2'] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const events = [
    { event_id: 'event_1', song_id: 's1', played_at: 1000 },
    { event_id: 'event_2', song_id: 's2', played_at: 2000 },
  ];

  const data = await submitAccountPlayStats(events, {
    expectedSubject: 'account-a',
    fetchImpl: mockFetch,
    apiBase: 'https://test-api.example.com',
    keepalive: true,
  });

  assert.equal(requestedUrl, 'https://test-api.example.com/api/account/play-stats');
  assert.equal(requestedInit.method, 'POST');
  assert.equal(requestedInit.headers['X-Requested-With'], 'FlareTune');
  assert.equal(requestedInit.headers['X-CSRF-Token'], 'local-csrf-test');
  assert.equal(requestedInit.headers['X-FlareTune-Expected-Account'], 'account-a');
  assert.equal(requestedInit.keepalive, true);
  assert.deepEqual(JSON.parse(requestedInit.body), { events });
  assert.equal(data.recorded, 2);
  assert.deepEqual(data.acceptedEventIds, ['event_1', 'event_2']);
});

test('accountPlayStats client: handles server error', async () => {
  const mockFetch = async () => new Response(JSON.stringify({
    ok: false,
    error: 'AUTH_REQUIRED',
    message: '请先登录。',
  }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  await assert.rejects(
    () => fetchAccountPlayStats({
      fetchImpl: mockFetch,
      apiBase: 'https://test-api.example.com',
    }),
    (err) => {
      assert.ok(err instanceof AccountPlayStatsRequestError);
      assert.equal(err.code, 'AUTH_REQUIRED');
      assert.equal(err.status, 401);
      return true;
    },
  );
});
