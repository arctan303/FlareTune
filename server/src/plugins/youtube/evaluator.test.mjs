import test from 'node:test';
import assert from 'node:assert/strict';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { evaluatePlayerInEngine } from './evaluator-core.mjs';
const engine = await newQuickJSWASMModuleFromVariant(variant);
const evaluate = (data, limits) => evaluatePlayerInEngine(engine, data, limits);

test('real player VM has no host process, filesystem or network bridge', () => {
  assert.deepEqual(evaluate({ output: 'return {sig:[typeof process,typeof require,typeof fetch,typeof console].join(","),n:"ok"};' }),
    { sig: 'undefined,undefined,undefined,undefined', n: 'ok' });
});
test('real player VM bounds computation, result size and valid return shape', () => {
  assert.throws(() => evaluate({ output: 'while(true){}' }, { maxTimeMs: 25 }), { code: 'YOUTUBE_QUICKJS_INTERNALERROR' });
  assert.throws(() => evaluate({ output: 'return {sig:"x".repeat(20000)};' }), { code: 'YOUTUBE_JS_RESULT_LIMIT' });
  assert.throws(() => evaluate({ output: 'return null;' }), { code: 'YOUTUBE_QUICKJS_TYPEERROR' });
  assert.throws(() => evaluate({ output: 'x'.repeat(2097153) }), { code: 'YOUTUBE_JS_INPUT_LIMIT' });
});
test('a frozen workerd-style clock cannot disable the real VM interrupt budget', t => {
  t.mock.method(Date, 'now', () => 1000);
  assert.throws(() => evaluate({ output: 'while(true){}' }, { maxInterrupts: 3 }), { code: 'YOUTUBE_QUICKJS_INTERNALERROR' });
});
test('recursion and memory exhaustion fail inside the VM and the shared engine recovers', () => {
  assert.throws(() => evaluate({ output: 'function recurse(){return recurse()}return recurse();' }), { code: 'YOUTUBE_QUICKJS_INTERNALERROR' });
  assert.throws(() => evaluate({ output: 'return {sig:new ArrayBuffer(67108864)};' }), { code: 'YOUTUBE_QUICKJS_INTERNALERROR' });
  assert.deepEqual(evaluate({ output: 'return {n:"still-ready"};' }), { n: 'still-ready' });
});
