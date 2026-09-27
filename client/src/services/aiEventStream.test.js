import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeSseJsonStream, decodeSseJsonLine } from './aiEventStream.js';

const encodeStream = (...chunks) => new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
    controller.close();
  },
});

test('decodes tool and player events split across stream chunks', async () => {
  const events = [];
  await consumeSseJsonStream(encodeStream(
    'data: {"type":"tool_call","pro',
    'gress":"查找"}\r\ndata: {"type":"tool_result","data":{"songs":[]}}\n',
    'data: {"type":"player_action","playerAction":{"type":"control","action":"pause"}}\n',
  ), { onEvent: (event) => events.push(event) });

  assert.deepEqual(events.map((event) => event.type), ['tool_call', 'tool_result', 'player_action']);
  assert.equal(events[0].progress, '查找');
  assert.equal(events[2].playerAction.action, 'pause');
});

test('ignores non-data lines, invalid JSON and a residual incomplete line', async () => {
  const events = [];
  const invalid = [];
  await consumeSseJsonStream(encodeStream(
    'event: message\n',
    'data: not-json\n',
    'data: {"type":"done"}\n',
    'data: {"type":"player_action"}',
  ), {
    onEvent: (event) => events.push(event),
    onInvalidJson: (error, line) => invalid.push({ error, line }),
  });

  assert.deepEqual(events, [{ type: 'done' }]);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].line, 'data: not-json');
  assert.equal(decodeSseJsonLine('data:{"type":"done"}'), undefined);
});

test('aborts a pending stream with AbortError and executes no event', async () => {
  const controller = new AbortController();
  const events = [];
  const pending = consumeSseJsonStream(new ReadableStream({ start() {} }), {
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });
  controller.abort();

  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.deepEqual(events, []);
});
