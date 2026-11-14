import { hydratePlayableSong } from '../utils.js';
import { applyPlaySongNow, applyPlayerControl, applyPlayerQueueEdit, applyReplacePlayerQueue } from './playerActionPrimitives.js';

export async function dispatchScopedPlayerAction(action, { playerStore, isCurrent, signal, subscribe, notify }) {
  const assertCurrent = () => { if (!isCurrent() || signal?.aborted) throw new DOMException('Plugin session ended', 'AbortError'); };
  const pending = new Set();
  const audioWrappers = new WeakMap();
  const stopRetired = () => {
    if (isCurrent() && !signal?.aborted) return;
    for (const item of pending) {
      const state = playerStore.getState();
      if (state.currentSong === item.song && state.audioRef?.current === item.audio && item.audio.src === item.src
        && state.playbackOwnershipGeneration === item.generation) {
        item.audio.pause(); state.setIsPlaying?.(false);
      }
    }
  };
  const unsubscribe = subscribe(stopRetired);
  signal?.addEventListener('abort', stopRetired);
  const cleanup = () => { if (!pending.size) { unsubscribe(); signal?.removeEventListener('abort', stopRetired); } };
  const audioProxy = (audio, song) => {
    if (!audio) return audio;
    const cached = audioWrappers.get(audio);
    if (cached?.song === song) return cached.proxy;
    const proxy = new Proxy(audio, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === 'play') return () => {
      assertCurrent();
      const item = { audio, song, src: audio.src, generation: playerStore.getState().playbackOwnershipGeneration }; pending.add(item);
      let result;
      try { result = target.play(); } catch (error) { pending.delete(item); cleanup(); throw error; }
      return Promise.resolve(result).then(value => { stopRetired(); assertCurrent(); return value; })
        .finally(() => { pending.delete(item); cleanup(); });
    };
    return typeof value === 'function' ? (...args) => { assertCurrent(); return value.apply(target, args); } : value;
    }, set(target, key, value) { assertCurrent(); return Reflect.set(target, key, value, target); } });
    audioWrappers.set(audio, { song, proxy });
    return proxy;
  };
  const getState = () => {
    assertCurrent();
    const state = playerStore.getState();
    return new Proxy(state, { get(target, key) {
      if (key === 'audioRef') return { current: audioProxy(target.audioRef?.current, target.currentSong) };
      const value = target[key];
      return typeof value === 'function' ? (...args) => { assertCurrent(); return value(...args); } : value;
    } });
  };
  try {
    assertCurrent();
    const song = action?.song ? hydratePlayableSong(action.song) : null;
    const songs = Array.isArray(action?.songs) ? action.songs.map(hydratePlayableSong).filter(Boolean) : [];
    if (action?.type === 'play_now' && action.action === 'play_song' && song) return await applyPlaySongNow(song, { getState });
    if (action?.type === 'insert_next' && action.action === 'insert_next' && (song || songs[0]))
      return await applyPlayerQueueEdit({ operation: 'insert_next', songs: [song || songs[0]] }, { getState });
    if (action?.type === 'replace_queue' && action.action === 'replace' && songs.length)
      return await applyReplacePlayerQueue(songs, { getState });
    if (action?.type === 'append' && action.action === 'append' && songs.length)
      return await applyPlayerQueueEdit({ operation: 'append', songs }, { getState });
    if ((action?.type === 'control' && ['play', 'pause', 'toggle'].includes(action.action))
      || (action?.type === 'seek' && action.action === 'seek')) return await applyPlayerControl(action, { getState });
    return { ok: false, outcome: 'ignored' };
  } finally { cleanup(); }
}
