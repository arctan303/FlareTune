import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiChatTiming } from './aiChatTiming.js';

test('chat timing contains only anonymous phase durations and model metadata', () => {
  let current = 1000;
  const timing = createAiChatTiming({ now: () => current });
  timing.setModel('gemini', 'gemini-test');
  current += 10;
  timing.modelRequestStarted();
  current += 20;
  timing.streamEvent({ type: 'first_chunk' });
  current += 5;
  timing.visibleContent();
  current += 10;
  timing.streamEvent({ type: 'finish_reason', finishReason: 'STOP' });
  current += 5;
  const snapshot = timing.finalize('success');

  assert.deepEqual(snapshot, {
    event: 'xiaoa_chat_timing',
    provider: 'gemini',
    model: 'gemini-test',
    rounds: 1,
    outcome: 'success',
    errorCode: '',
    finishReason: 'STOP',
    streamEnd: 'finish_reason',
    preflightMs: 10,
    firstUpstreamChunkMs: 30,
    firstVisibleContentMs: 35,
    finishReasonMs: 45,
    streamEndMs: null,
    totalMs: 50,
  });
  assert.equal(JSON.stringify(snapshot).includes('user'), false);
  assert.equal(timing.finalize('success'), null);
});
