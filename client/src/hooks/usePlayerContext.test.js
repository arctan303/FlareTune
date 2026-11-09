import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

const song = id => ({ id, audio_url: `/${id}.mp3` });
function fixture() {
  let auth = { initialized: true, authenticated: true, user: { accountId: 'A', role: 'member' }, csrfToken: 'A' };
  const reads = [], listeners = new Set(), readyStates = [];
  let state = { playlist: [song('preserved')], currentSong: song('preserved'), progress: 0, duration: 0,
    isPlaying: true, queueContextReady: false,
    setQueueContextReady(ready) { readyStates.push(ready); state = { ...state, queueContextReady: ready }; },
  };
  const playerStore = { getState: () => state,
    setState(patch) { const previous = state; state = { ...state, ...patch }; for (const listener of [...listeners]) listener(state, previous); },
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const uiStore = selector => selector({ authSession: auth });
  uiStore.getState = () => ({ authSession: auth });
  const hook = createBackgroundModuleHarness({ file: new URL('./usePlayerContext.js', import.meta.url),
    render: exports => exports.usePlayerContext({ current: null }), modules: {
      '../store/usePlayerStore': { usePlayerStore: playerStore }, '../store/useUIStore': { useUIStore: uiStore },
      '../utils': { getApiBaseUrl: () => '', hydratePlayableSong: value => value },
      '../resolveSongs': { repairSongLanguages: async songs => ({ songs, repairedSongIds: [], unresolvedSongIds: [] }) },
      '../playerContext': { readPlayerContext: () => new Promise(resolve => reads.push(resolve)),
        clearPlayerContext: async () => {}, writePlayerContext: async () => {}, updatePlayerPosition: async () => {},
        patchPlayerContextSongMetadata: async () => {}, claimPlayerContext: async () => {} },
    }, globals: { AbortController,
      window: { addEventListener() {}, removeEventListener() {} }, document: { addEventListener() {}, removeEventListener() {} },
    },
  });
  return { hook, reads, readyStates, get state() { return state; },
    account(accountId) { auth = { ...auth, user: { ...auth.user, accountId }, csrfToken: accountId }; },
    answer(index, id) { reads[index](id ? { queue: [song(id)], currentSongId: id, position: 23, duration: 100 } : null); },
  };
}

test('context readiness belongs to the restored account; switching accounts closes the queue gate immediately', async t => {
  const f = fixture(); t.after(() => f.hook.unmount());
  assert.equal(f.hook.render().isPlayerContextReady, false);
  f.answer(0, 'a'); await flushBackgroundAsync();
  assert.equal(f.hook.render().isPlayerContextReady, true);
  assert.equal(f.state.queueContextReady, true);
  assert.equal(f.state.currentSong.id, 'a');
  f.account('B');
  assert.equal(f.hook.render().isPlayerContextReady, false);
  assert.equal(f.state.queueContextReady, false);
  f.account('C'); f.hook.render();
  f.answer(1, 'stale-b'); await flushBackgroundAsync();
  assert.equal(f.state.currentSong.id, 'a', 'a retired restore cannot replace the preserved queue');
  assert.equal(f.state.queueContextReady, false);
  f.answer(2, 'c'); await flushBackgroundAsync();
  assert.equal(f.hook.render().isPlayerContextReady, true);
  assert.equal(f.state.currentSong.id, 'c');
  assert.equal(f.state.isPlaying, false);
  assert.equal(f.state.shouldAutoPlay, false);
  f.hook.unmount();
  assert.equal(f.state.queueContextReady, false);
});

test('a restore response arriving before the account-change render cannot publish an old queue or ready flag', async t => {
  const f = fixture(); t.after(() => f.hook.unmount());
  f.hook.render(); f.account('B');
  f.answer(0, 'stale-a'); await flushBackgroundAsync();
  assert.equal(f.state.currentSong.id, 'preserved');
  assert.equal(f.state.queueContextReady, false);
  assert.equal(f.hook.render().isPlayerContextReady, false);
  f.answer(1, null); await flushBackgroundAsync();
  assert.equal(f.hook.render().isPlayerContextReady, true);
  assert.equal(f.state.currentSong.id, 'preserved');
});
