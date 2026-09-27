import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatchAiPlayerAction } from './aiPlayerActionDispatch.js';

const createDependencies = () => {
  const calls = [];
  return {
    calls,
    dependencies: {
      hydrateSong: (song) => ({ ...song, hydrated: true }),
      playNow: async (song) => { calls.push(['playNow', song]); return { ok: true }; },
      insertNext: (song) => { calls.push(['insertNext', song]); return { ok: true, outcome: 'applied' }; },
      replaceQueue: async (songs) => { calls.push(['replaceQueue', songs]); return { ok: true }; },
      appendQueue: async (songs) => { calls.push(['appendQueue', songs]); return { ok: true }; },
      controlPlayer: async (action) => { calls.push(['controlPlayer', action]); return { ok: true, position_seconds: 31 }; },
      setRoam: async (options) => { calls.push(['setRoam', options]); return { ok: true, outcome: 'applied', language: options.language }; },
      notify: (message) => calls.push(['notify', message]),
    },
  };
};

test('dispatches play-now and insert-next actions with hydrated songs', async () => {
  const { calls, dependencies } = createDependencies();
  await dispatchAiPlayerAction({
    type: 'play_now', action: 'play_song', song: { id: 's1', title: '一' },
  }, dependencies);
  await dispatchAiPlayerAction({
    type: 'insert_next', action: 'insert_next', songs: [{ id: 's2', title: '二' }],
  }, dependencies);

  assert.deepEqual(calls, [
    ['playNow', { id: 's1', title: '一', hydrated: true }],
    ['notify', '正在播放《一》'],
    ['insertNext', { id: 's2', title: '二', hydrated: true }],
    ['notify', '已将《二》插播为下一首'],
  ]);
});

test('dispatches queue tool actions and only reports successful mutations', async () => {
  const { calls, dependencies } = createDependencies();
  await dispatchAiPlayerAction({
    type: 'replace_queue', action: 'replace', songs: [{ id: 's1' }, null, { id: 's2' }],
  }, dependencies);
  dependencies.appendQueue = async (songs) => { calls.push(['appendQueue', songs]); return { ok: false }; };
  await dispatchAiPlayerAction({
    type: 'append', action: 'append', songs: [{ id: 's3' }],
  }, dependencies);

  assert.deepEqual(calls[0], ['replaceQueue', [
    { id: 's1', hydrated: true },
    { id: 's2', hydrated: true },
  ]]);
  assert.deepEqual(calls[1], ['notify', '已换上包含 2 首歌曲的播放队列']);
  assert.deepEqual(calls[2], ['appendQueue', [{ id: 's3', hydrated: true }]]);
  assert.equal(calls.length, 3);
});

test('failed insert-next reports the browser failure and does not show success', async () => {
  const { calls, dependencies } = createDependencies();
  dependencies.insertNext = (song) => { calls.push(['insertNext', song]); return { ok: false, error: 'invalid_queue_edit' }; };
  const result = await dispatchAiPlayerAction({ type: 'insert_next', action: 'insert_next',
    song: { id: 'bad', title: '无法播放' } }, dependencies);
  assert.deepEqual(result, { ok: false, outcome: 'invalid_queue_edit' });
  assert.equal(calls.some(([name]) => name === 'notify'), false);
});

test('dispatches controls and ignores invalid player action combinations', async () => {
  const { calls, dependencies } = createDependencies();
  const seek = await dispatchAiPlayerAction({ type: 'seek', action: 'seek', mode: 'seconds', position: 30 }, dependencies);
  const ignored = await dispatchAiPlayerAction({ type: 'control', action: 'replace' }, dependencies);

  assert.equal(seek.ok, true);
  assert.deepEqual(calls, [
    ['controlPlayer', { type: 'seek', action: 'seek', mode: 'seconds', position: 30 }],
    ['notify', '已跳到 31 秒'],
  ]);
  assert.deepEqual(ignored, { ok: false, outcome: 'ignored' });
});

test('dispatches roam control with the requested language and only toasts on success', async () => {
  const { calls, dependencies } = createDependencies();
  const enabled = await dispatchAiPlayerAction({ type: 'roam', action: 'enable', language: 'ja' }, dependencies);
  const disabled = await dispatchAiPlayerAction({ type: 'roam', action: 'disable' }, dependencies);
  const ignored = await dispatchAiPlayerAction({ type: 'roam', action: 'toggle' }, dependencies);

  assert.deepEqual(calls, [
    ['setRoam', { action: 'enable', language: 'ja' }],
    ['notify', '已开启【日文】随机漫游，将在队尾自动补充歌曲'],
    ['setRoam', { action: 'disable', language: undefined }],
    ['notify', '已关闭随机漫游'],
  ]);
  assert.deepEqual(enabled, { ok: true, outcome: 'applied' });
  assert.deepEqual(disabled, { ok: true, outcome: 'applied' });
  assert.deepEqual(ignored, { ok: false, outcome: 'ignored' });
});

test('roam failures report a failed outcome without a success toast', async () => {
  const { calls, dependencies } = createDependencies();
  dependencies.setRoam = async (options) => { calls.push(['setRoam', options]); return { ok: false, outcome: 'failed' }; };

  const result = await dispatchAiPlayerAction({ type: 'roam', action: 'enable', language: 'zh' }, dependencies);

  assert.deepEqual(result, { ok: false, outcome: 'failed' });
  assert.deepEqual(calls, [['setRoam', { action: 'enable', language: 'zh' }]]);
});

test('the retired daily_recommend action type is ignored and no longer wired', async () => {
  const { calls, dependencies } = createDependencies();

  const refreshed = await dispatchAiPlayerAction({ type: 'daily_recommend', action: 'refresh' }, dependencies);
  const played = await dispatchAiPlayerAction({ type: 'daily_recommend', action: 'play_all' }, dependencies);

  assert.deepEqual(refreshed, { ok: false, outcome: 'ignored' });
  assert.deepEqual(played, { ok: false, outcome: 'ignored' });
  assert.deepEqual(calls, []);
  assert.doesNotMatch(
    readFileSync(new URL('./aiPlayerActionDispatch.js', import.meta.url), 'utf8'),
    /daily_recommend/,
  );
});
