import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_TYPEWRITER_INTERVAL_MS,
  createAiResponseTypewriter,
  insertInlineCursorHtml,
  reconcileAiResponseContent,
} from './aiResponseTypewriter.js';

test('final content only appends the missing stream suffix or replaces mismatched text', () => {
  assert.deepEqual(reconcileAiResponseContent('你好，', '你好，听什么？'),
    { reset: false, append: '听什么？' });
  assert.deepEqual(reconcileAiResponseContent('你好，听什么？', '你好，听什么？'),
    { reset: false, append: '' });
  assert.deepEqual(reconcileAiResponseContent('临时正文 ', '最终回答'),
    { reset: true, append: '最终回答' });
});

test('typewriter defaults to the agreed 19ms cadence', () => {
  assert.equal(AI_TYPEWRITER_INTERVAL_MS, 19);
});

function makeScheduler() {
  const pending = [];
  return {
    schedule(callback) {
      const task = { callback, cancelled: false };
      pending.push(task);
      return task;
    },
    cancelSchedule(task) {
      task.cancelled = true;
    },
    runNext() {
      const task = pending.shift();
      if (task && !task.cancelled) task.callback();
    },
    runAll() {
      while (pending.length > 0) this.runNext();
    },
  };
}

test('typewriter reveals one grapheme per tick and drains before finish resolves', async () => {
  const scheduler = makeScheduler();
  const updates = [];
  const typewriter = createAiResponseTypewriter({
    onDisplay: (text) => updates.push(text),
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  typewriter.append('第一段');
  typewriter.append('，第二段');
  const finished = typewriter.finish();

  assert.deepEqual(updates, []);
  scheduler.runNext();
  assert.deepEqual(updates, ['第']);
  assert.equal(typewriter.isBusy(), true);

  scheduler.runAll();
  assert.equal(await finished, '第一段，第二段');
  assert.equal(updates.at(-1), '第一段，第二段');
  assert.equal(updates.every((text, index) => index === 0 || Array.from(text).length === Array.from(updates[index - 1]).length + 1), true);
  assert.equal(typewriter.isBusy(), false);
});

test('finishing a complete long reply keeps a visible typing sequence instead of jumping to its tail', async () => {
  const scheduler = makeScheduler();
  const updates = [];
  const reply = '长'.repeat(240);
  const typewriter = createAiResponseTypewriter({
    onDisplay: (text) => updates.push(text),
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  typewriter.append(reply);
  const finished = typewriter.finish();
  assert.deepEqual(updates, []);
  scheduler.runNext();
  assert.equal(updates[0].length, 2);
  scheduler.runAll();
  assert.equal(await finished, reply);
  assert.ok(updates.length > 100);
  assert.equal(updates.at(-1), reply);
});

test('typewriter resegments accumulated chunks so a split Unicode grapheme stays intact', () => {
  const scheduler = makeScheduler();
  const updates = [];
  const typewriter = createAiResponseTypewriter({
    onDisplay: (text) => updates.push(text),
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  typewriter.append('👩\u200d');
  typewriter.append('💻');
  scheduler.runNext();

  assert.deepEqual(updates, ['👩\u200d💻']);
  assert.equal(typewriter.getDisplayedText(), '👩\u200d💻');
});

test('typewriter reset discards streamed tool preamble and accepts the final answer', async () => {
  const scheduler = makeScheduler();
  const updates = [];
  const typewriter = createAiResponseTypewriter({
    onDisplay: (text) => updates.push(text),
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  typewriter.append('临时的工具调用说明');
  scheduler.runNext();
  assert.equal(typewriter.getDisplayedText(), '临');

  assert.equal(typewriter.reset(), '');
  assert.equal(typewriter.getFullText(), '');
  assert.equal(typewriter.getDisplayedText(), '');
  assert.equal(updates.at(-1), '');

  typewriter.append('最终回答');
  const finished = typewriter.finish();
  scheduler.runAll();

  assert.equal(await finished, '最终回答');
  assert.equal(typewriter.getFullText(), '最终回答');
  assert.equal(updates.includes('临时的工具调用说明'), false);
});

test('typewriter cancel stops pending output and resolves an in-flight drain without flushing hidden text', async () => {
  const scheduler = makeScheduler();
  const updates = [];
  const typewriter = createAiResponseTypewriter({
    onDisplay: (text) => updates.push(text),
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  typewriter.append('不会整段跳出');
  const finished = typewriter.finish();
  scheduler.runNext();
  assert.equal(typewriter.cancel(), '不');
  scheduler.runAll();

  assert.equal(await finished, '不');
  assert.deepEqual(updates, ['不']);
  assert.equal(typewriter.getFullText(), '不');
});

test('reduced motion displays received text immediately', async () => {
  const updates = [];
  const typewriter = createAiResponseTypewriter({
    onDisplay: (text) => updates.push(text),
    prefersReducedMotion: true,
  });

  typewriter.append('立即显示');
  assert.deepEqual(updates, ['立即显示']);
  assert.equal(await typewriter.finish(), '立即显示');
});

test('inline cursor follows the last visible markdown character', () => {
  const cursor = '<span class="ai-typing-cursor" aria-hidden="true"></span>';
  assert.equal(insertInlineCursorHtml(''), cursor);
  assert.equal(insertInlineCursorHtml('<p>末字</p>\n'), `<p>末字${cursor}</p>`);
  assert.equal(insertInlineCursorHtml('<ul><li>一</li><li>二</li></ul>\n'), `<ul><li>一</li><li>二${cursor}</li></ul>`);
  assert.equal(insertInlineCursorHtml('<pre><code>const a = 1;</code></pre>\n'), `<pre><code>const a = 1;${cursor}</code></pre>`);
  assert.equal(insertInlineCursorHtml('<blockquote><p>引用</p></blockquote>\n'), `<blockquote><p>引用${cursor}</p></blockquote>`);
  assert.equal(insertInlineCursorHtml('<table><tbody><tr><td>单元格</td></tr></tbody></table>\n'), `<table><tbody><tr><td>单元格${cursor}</td></tr></tbody></table>`);
});
