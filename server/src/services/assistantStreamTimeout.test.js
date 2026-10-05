import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { chatAI } from './ai.js';

const config = { provider: 'deepseek', model: 'deepseek-chat' };
const env = { DEEPSEEK_API_KEY: 'test-key' };
const encoder = new TextEncoder();
const fragment = content => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);

test('idle-only assistant streaming survives total duration with heartbeats and text, but still times out when silent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  let stream;
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  });
  try {
    const promise = chatAI([{ role: 'user', content: '长思考' }], [], config, env,
      { timeoutPolicy: 'idle', timeoutMs: 5000, streamIdleTimeoutMs: 15000 });
    await settle();
    for (let i = 0; i < 10; i++) {
      t.mock.timers.tick(10000);
      stream.enqueue(i % 2 ? fragment('答') : encoder.encode(': keepalive\n\n'));
      await settle();
      assert.equal(signal.aborted, false);
    }
    stream.enqueue(encoder.encode('data: [DONE]\n\n'));
    assert.equal((await promise).content, '答'.repeat(5));
    const silent = chatAI([{ role: 'user', content: '静默' }], [], config, env,
      { timeoutPolicy: 'idle', streamIdleTimeoutMs: 15000 });
    const rejected = assert.rejects(silent, /AI_STREAM_IDLE_TIMEOUT/);
    await settle();
    t.mock.timers.tick(15001);
    await rejected;
  } finally { t.mock.timers.reset(); }
});

test('assistant retains a connection timeout and propagates explicit cancellation upstream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  });
  try {
    const connecting = chatAI([{ role: 'user', content: '连接' }], [], config, env,
      { timeoutPolicy: 'idle', connectionTimeoutMs: 5000 });
    const rejected = assert.rejects(connecting, /AI_TIMEOUT/);
    t.mock.timers.tick(5001);
    await rejected;
    assert.equal(signal.aborted, true);
    const controller = new AbortController();
    const cancelled = chatAI([{ role: 'user', content: '取消' }], [], config, env,
      { timeoutPolicy: 'idle', signal: controller.signal });
    const abortRejected = assert.rejects(cancelled, /AI_TIMEOUT/);
    controller.abort();
    await abortRejected;
    assert.equal(signal.aborted, true);
  } finally { t.mock.timers.reset(); }
});
