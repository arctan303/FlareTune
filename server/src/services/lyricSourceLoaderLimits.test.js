import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricSourceLoader } from './lyricSourceLoader.js';

const SONG = { id: 'song-1', title: '夜航', artist: '歌手甲、歌手乙', album: '夜航集', duration: 200 };

test('body reading enforces Content-Length, chunked byte caps, stalled-body timeout, and circuit opening', async () => {
  const forbidden = createLyricSourceLoader({ fetchImpl: async () => new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(() => forbidden.getLrclibDocument(SONG), { name: 'LyricSourceError', kind: 'invalid' });

  const oversizedByHeader = createLyricSourceLoader({
    fetchImpl: async () => new Response('{}', { headers: { 'content-length': '5000000' } }),
  });
  await assert.rejects(() => oversizedByHeader.getLrclibDocument(SONG), { name: 'LyricSourceError', kind: 'invalid' });

  const chunk = new Uint8Array(2_100_000);
  const chunked = createLyricSourceLoader({
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    })),
  });
  await assert.rejects(() => chunked.getLrclibDocument(SONG), { name: 'LyricSourceError', kind: 'invalid' });

  const stalled = createLyricSourceLoader({
    timeoutMs: 10,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text() {},
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
    }),
  });
  await assert.rejects(() => stalled.getLrclibDocument(SONG), { name: 'LyricSourceError', kind: 'timeout' });

  let networkCalls = 0;
  const circuit = createLyricSourceLoader({
    circuitFailureThreshold: 2,
    circuitCooldownMs: 60_000,
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('network down');
    },
  });
  await assert.rejects(() => circuit.getLrclibDocument(SONG), { kind: 'network' });
  await assert.rejects(() => circuit.getLrclibDocument(SONG), { kind: 'network' });
  await assert.rejects(() => circuit.getLrclibDocument(SONG), { kind: 'circuit_open' });
  assert.equal(networkCalls, 2);
});
