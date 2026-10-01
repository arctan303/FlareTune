import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useRandomRoam } from '../../client/src/hooks/useRandomRoam.js';
import { usePlayerStore } from '../../client/src/store/usePlayerStore.js';
import { useUIStore } from '../../client/src/store/useUIStore.js';
import { createInactiveRandomRoam } from '../../client/src/randomRoam.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) { for (let i = 0; i < 200; i++) { if (check()) return; await wait(15); } throw Error(message); }
function assert(ok, message) { if (!ok) throw Error(message); }
const makeSong = (id, language = 'en') => ({ id, title: id, artist: 'Fixture', audio_url: `/${id}.mp3`, language });
let catalog = [], calls = [], hold = false, release;
globalThis.fetch = async (input, init) => {
  if (!String(input).endsWith('/api/songs/roam')) return Response.json({ data: {} });
  const body = JSON.parse(init.body); calls.push(body);
  if (hold) await new Promise((resolve, reject) => {
    release = resolve;
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const range = catalog.filter(song => !body.language || body.language.split(',').includes(song.language));
  const queued = new Set(body.queuedSongIds);
  const candidates = range.filter(song => !queued.has(song.id));
  const windowSize = Math.floor(range.length * .2);
  const recent = windowSize ? body.recentSongIds.slice(-windowSize) : [];
  while (candidates.filter(song => !recent.includes(song.id)).length < Math.min(body.limit, candidates.length)) recent.shift();
  const eligible = candidates.filter(song => !recent.includes(song.id));
  const songs = eligible.slice(0, body.limit);
  return Response.json({ data: { songs, strategy: 'recent', recentWindow: windowSize,
    totalPlayable: range.length, remainingPlayable: eligible.length - songs.length,
    exhausted: range.length === 0 || (!songs.length && queued.size <= 1) } });
};
useUIStore.setState({ authSession: { authenticated: true, user: { accountId: 'fixture' }, csrfToken: 'fixture' } });
const root = createRoot(document.getElementById('fixture'));
function Harness() {
  useRandomRoam({ authenticated: true, isPlayerContextReady: true });
  const state = usePlayerStore();
  return <p>{state.randomRoam.status} · {state.currentSong?.id} · queue {state.playlist.length}</p>;
}
function reset(size) {
  flushSync(() => root.render(null)); calls = []; hold = false;
  catalog = Array.from({ length: size }, (_, i) => makeSong(`s${i}`));
  usePlayerStore.setState({ playlist: [], currentSong: null, audioRef: null, isPlaying: false,
    randomRoam: createInactiveRandomRoam(), playMode: 'sequence' });
  flushSync(() => root.render(<Harness />));
}
document.getElementById('run').onclick = async () => {
  document.getElementById('run').disabled = true;
  const report = document.getElementById('report'); report.textContent = '';
  const pass = msg => { report.textContent += `PASS ${msg}\n`; };
  const state = () => usePlayerStore.getState();
  try {
    reset(3); state().setRandomRoamEnabled(true);
    await until(() => state().playlist.length === 3 && state().randomRoam.status === 'idle', 'small queue did not fill');
    const initial = calls.length; await wait(150);
    assert(calls.length === initial, 'full queue looped requests');
    for (let i = 0; i < 12; i++) {
      const previous = state().currentSong.id;
      const before = calls.length;
      state().playNext();
      await until(() => calls.length > before && state().randomRoam.status === 'idle' && state().playlist.length === 3, 'continuation failed');
      assert(state().currentSong.id !== previous, 'current song repeated immediately');
      assert(new Set(state().playlist.map(s => s.id)).size === 3, 'duplicate queue IDs');
      assert(state().randomRoam.enabled, 'small catalog ended prematurely');
    }
    assert(calls.length <= initial + 12, 'more than one refill per transition');
    pass('3-song library keeps playing across 12 transitions, with unique queue IDs and no request loop');
    state().removePlaylistSong(state().playlist.at(-1).id);
    await until(() => state().playlist.length === 3, 'deleting pending song blocked refill');
    pass('removing a queued song permits another refill');
    reset(30); state().setRandomRoamEnabled(true);
    await until(() => state().playlist.length === 10, 'initial batch absent');
    hold = true; catalog.push(makeSong('jp1', 'ja'), makeSong('jp2', 'ja'));
    state().setRandomRoamLanguage('en');
    await until(() => state().randomRoam.status === 'loading' && release, 'held old-language request missing');
    hold = false; state().setRandomRoamLanguage('ja');
    await until(() => state().playlist.some(s => s.id === 'jp1') && state().randomRoam.status === 'idle', 'new-language request did not replace old request');
    assert(state().playlist.slice(1).every(s => s.language === 'ja'), 'old-language songs leaked');
    pass('changing language during an in-flight request cancels it and keeps the new selection');
    reset(30); state().setRandomRoamEnabled(true);
    await until(() => state().playlist.length === 10, 'batch missing');
    state().setRandomRoamEnabled(false); state().triggerManualRandomRoam();
    await until(() => state().playlist.length === 20, 'single manual batch was aborted');
    assert(!state().randomRoam.enabled, 'single addition enabled automatic mode');
    pass('existing one-time queue addition works while automatic roam is paused');
    reset(1); state().setRandomRoamEnabled(true);
    await until(() => state().playlist.length === 1, 'single-song startup missing');
    state().playNext();
    await until(() => state().randomRoam.exhausted, 'single-song exhaustion missing');
    const count = calls.length; await wait(150); assert(calls.length === count, 'single song loops');
    pass('single-song library does not busy-loop');
    report.textContent += 'ALL 5 SCENARIOS PASSED';
  } catch (error) { report.textContent += `FAIL ${error.stack}`; }
};
