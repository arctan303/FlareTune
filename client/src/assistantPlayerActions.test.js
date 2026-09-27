import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCurrentSongMetadataAndToggle,
  applyPlaySongNow,
  applyPlayerControl,
  applyPlayerQueueEdit,
  applyReplacePlayerQueue,
  applyRoamControl,
} from './assistantPlayerActions.js';

const song = (id) => ({ id, title: id, artist: 'Artist', audio_url: `audio/${id}.mp3` });

const makeState = ({ playlist = [], currentSong = null, audio = null } = {}) => {
  let state;
  const setters = {
    setPlaylist: (value) => { state.playlist = value; },
    setShouldAutoPlay: (value) => { state.shouldAutoPlay = value; },
    setIsPlaying: (value) => { state.isPlaying = value; },
    setProgress: (value) => { state.progress = value; },
    playSong: (nextSong, nextPlaylist) => {
      state.currentSong = nextSong;
      state.playlist = nextPlaylist;
      state.isPlaying = true;
      if (state.audioRef.current) state.audioRef.current.src = nextSong.audio_url;
      return true;
    },
  };
  state = {
    playlist,
    currentSong,
    audioRef: { current: audio },
    duration: audio?.duration || 0,
    ...setters,
  };
  return { getState: () => state, state };
};

test('queue editor inserts multiple songs after current and reports noop precisely', () => {
  const a = song('a');
  const b = song('b');
  const x = song('x');
  const fixture = makeState({ playlist: [a, b], currentSong: a });
  const applied = applyPlayerQueueEdit({ operation: 'insert_next', songs: [x] }, fixture);
  assert.equal(applied.outcome, 'applied');
  assert.deepEqual(fixture.state.playlist.map((item) => item.id), ['a', 'x', 'b']);
  const noop = applyPlayerQueueEdit({ operation: 'insert_next', songs: [x] }, fixture);
  assert.equal(noop.outcome, 'noop');
});

test('current XiaoA song action patches authoritative language before toggling playback', () => {
  const calls = [];
  const currentSong = { ...song('a'), language: null };
  const authoritative = { ...song('a'), title: 'Authoritative', language: 'en' };
  const state = {
    currentSong,
    patchSongMetadata: (songId, patch) => {
      calls.push(['patch', songId, patch.language, Object.keys(patch)]);
      state.currentSong = { ...state.currentSong, ...patch };
    },
    togglePlay: () => calls.push(['toggle']),
  };

  assert.equal(applyCurrentSongMetadataAndToggle(authoritative, { getState: () => state }), true);
  assert.deepEqual(calls, [['patch', 'a', 'en', ['language']], ['toggle']]);
  assert.equal(state.currentSong.language, 'en');
  assert.equal(state.currentSong.title, 'a');
  assert.equal(applyCurrentSongMetadataAndToggle({ ...song('a'), language: null }, { getState: () => state }), false);
  assert.equal(applyCurrentSongMetadataAndToggle({ ...song('b'), language: 'ja' }, { getState: () => state }), false);
});

test('direct play waits for the real media play promise', async () => {
  const a = song('a');
  const x = song('x');
  let plays = 0;
  const audio = { currentTime: 12, play: async () => { plays += 1; } };
  const fixture = makeState({ playlist: [a], currentSong: a, audio });
  const result = await applyPlaySongNow(x, fixture);
  assert.equal(result.ok, true);
  assert.equal(plays, 1);
  assert.equal(fixture.state.currentSong.id, 'x');
  assert.deepEqual(fixture.state.playlist.map((item) => item.id), ['a', 'x']);
});

test('play now inserts right after the current song without replacing the queue', async () => {
  const a = song('a');
  const b = song('b');
  const c = song('c');
  const x = song('x');
  const audio = { currentTime: 0, play: async () => {} };
  const fixture = makeState({ playlist: [a, b, c], currentSong: a, audio });

  const result = await applyPlaySongNow(x, { ...fixture, playbackObservationMs: 5 });
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.state.playlist.map((item) => item.id), ['a', 'x', 'b', 'c']);
});

test('play now moves an already queued target to directly after the current song', async () => {
  const a = song('a');
  const b = song('b');
  const c = song('c');
  const x = song('x');
  const audio = { currentTime: 0, play: async () => {} };
  const fixture = makeState({ playlist: [a, b, x, c], currentSong: a, audio });

  const result = await applyPlaySongNow(x, { ...fixture, playbackObservationMs: 5 });
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.state.playlist.map((item) => item.id), ['a', 'x', 'b', 'c']);
});

test('play now on the current song keeps the queue untouched and resumes it', async () => {
  const a = song('a');
  const b = song('b');
  const audio = { currentTime: 0, play: async () => {} };
  const fixture = makeState({ playlist: [a, b], currentSong: a, audio });

  const result = await applyPlaySongNow(a, { ...fixture, playbackObservationMs: 5 });
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.state.playlist.map((item) => item.id), ['a', 'b']);
});

test('direct play reports buffering without blocking on a slow media source', async () => {
  const x = song('x');
  const audio = {
    paused: true,
    currentTime: 0,
    play: () => new Promise(() => {}),
  };
  const fixture = makeState({ audio });
  const result = await applyPlaySongNow(x, { ...fixture, playbackObservationMs: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'applied');
  assert.equal(result.playback_state, 'buffering');
  assert.equal(fixture.state.isPlaying, true);
});

test('direct play accepts the newly assigned src while currentSrc still points at the previous song', async () => {
  const a = song('a');
  const x = song('x');
  let plays = 0;
  const audio = {
    currentSrc: a.audio_url,
    src: a.audio_url,
    currentTime: 12,
    play: async () => { plays += 1; },
  };
  const fixture = makeState({ playlist: [a], currentSong: a, audio });

  const result = await applyPlaySongNow(x, fixture);

  assert.equal(result.ok, true);
  assert.equal(plays, 1);
  assert.equal(fixture.state.currentSong.id, 'x');
});

test('direct play does not trust a stale matching currentSrc when the declared src is another song', async () => {
  const a = song('a');
  const x = song('x');
  const audio = {
    currentSrc: x.audio_url,
    currentTime: 12,
    play: async () => {},
  };
  Object.defineProperty(audio, 'src', {
    configurable: true,
    get: () => a.audio_url,
    set: () => {},
  });
  const fixture = makeState({ playlist: [a], currentSong: a, audio });

  const result = await applyPlaySongNow(x, { ...fixture, timeoutMs: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'audio_unavailable');
});

test('direct play reports superseded when another song takes over before play resolves', async () => {
  const a = song('a');
  const x = song('x');
  const y = song('y');
  let resolvePlay;
  const audio = {
    currentTime: 12,
    play: () => new Promise((resolve) => { resolvePlay = resolve; }),
  };
  const fixture = makeState({ playlist: [a], currentSong: a, audio });

  const pending = applyPlaySongNow(x, fixture);
  await Promise.resolve();
  const replacementAudio = { src: y.audio_url, currentTime: 0, play: async () => {} };
  fixture.state.currentSong = y;
  fixture.state.playlist = [a, x, y];
  fixture.state.audioRef.current = replacementAudio;
  fixture.state.isPlaying = true;
  resolvePlay();
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.error, 'playback_superseded');
  assert.equal(fixture.state.currentSong.id, 'y');
  assert.equal(fixture.state.isPlaying, true);
});

test('a rejected superseded play does not pause the replacement song', async () => {
  const a = song('a');
  const x = song('x');
  const y = song('y');
  let rejectPlay;
  const audio = {
    currentTime: 12,
    play: () => new Promise((resolve, reject) => { rejectPlay = reject; }),
  };
  const fixture = makeState({ playlist: [a], currentSong: a, audio });

  const pending = applyPlaySongNow(x, fixture);
  await Promise.resolve();
  fixture.state.currentSong = y;
  fixture.state.audioRef.current = { src: y.audio_url };
  fixture.state.isPlaying = true;
  rejectPlay(new Error('old source aborted'));
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.error, 'playback_superseded');
  assert.equal(fixture.state.isPlaying, true);
});

test('direct play reports browser rejection instead of claiming success', async () => {
  const x = song('x');
  const audio = { currentTime: 0, play: async () => { throw new Error('blocked'); } };
  const fixture = makeState({ audio });
  const result = await applyPlaySongNow(x, fixture);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'playback_rejected');
  assert.equal(result.playback_state, 'failed');
  assert.equal(result.outcome, 'partial');
  assert.equal(fixture.state.isPlaying, false);
});

test('queue replacement reports partial when the queue changed but browser playback was rejected', async () => {
  const a = song('a');
  const b = song('b');
  const audio = { currentTime: 0, play: async () => { throw new Error('blocked'); } };
  const fixture = makeState({ audio });
  const result = await applyReplacePlayerQueue([a, b], fixture);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.error, 'playback_rejected');
  assert.deepEqual(fixture.state.playlist.map((item) => item.id), ['a', 'b']);
});

test('player controls are idempotent and clamp seek positions', async () => {
  let pauses = 0;
  const audio = {
    paused: false,
    currentTime: 20,
    duration: 100,
    play: async () => {},
    pause() { this.paused = true; pauses += 1; },
  };
  const fixture = makeState({ currentSong: song('a'), audio });
  const paused = await applyPlayerControl({ type: 'control', action: 'pause' }, fixture);
  assert.equal(paused.outcome, 'applied');
  assert.equal(pauses, 1);
  const pausedAgain = await applyPlayerControl({ type: 'control', action: 'pause' }, fixture);
  assert.equal(pausedAgain.outcome, 'noop');
  const seek = await applyPlayerControl({ type: 'seek', action: 'seek', mode: 'percent', position: 125 }, fixture);
  assert.equal(seek.position_seconds, 100);
  assert.equal(fixture.state.progress, 100);
});

test('applyPlayerControl handles action="seek" with seconds and percent mode', async () => {
  const audio = {
    paused: false,
    currentTime: 10,
    duration: 200,
  };
  const fixture = makeState({ currentSong: song('a'), audio });

  // Test seek by seconds mode
  const seekSeconds = await applyPlayerControl({
    type: 'seek',
    action: 'seek',
    mode: 'seconds',
    position: 45,
  }, fixture);
  assert.equal(seekSeconds.ok, true);
  assert.equal(seekSeconds.outcome, 'applied');
  assert.equal(seekSeconds.position_seconds, 45);
  assert.equal(audio.currentTime, 45);
  assert.equal(fixture.state.progress, 45);

  // Test seek by percent mode
  const seekPercent = await applyPlayerControl({
    type: 'seek',
    action: 'seek',
    mode: 'percent',
    position: 50,
  }, fixture);
  assert.equal(seekPercent.ok, true);
  assert.equal(seekPercent.outcome, 'applied');
  assert.equal(seekPercent.position_seconds, 100);
  assert.equal(audio.currentTime, 100);
  assert.equal(fixture.state.progress, 100);
});

test('applyPlayerControl uses currentSong duration fallback if audio.duration is not yet ready', async () => {
  const audio = {
    paused: false,
    currentTime: 0,
    duration: NaN,
  };
  const currentSong = { ...song('a'), duration: 180 };
  const fixture = makeState({ currentSong, audio });

  const seekPercent = await applyPlayerControl({
    type: 'seek',
    action: 'seek',
    mode: 'percent',
    position: 25,
  }, fixture);

  assert.equal(seekPercent.ok, true);
  assert.equal(seekPercent.position_seconds, 45);
  assert.equal(audio.currentTime, 45);
  assert.equal(fixture.state.progress, 45);
});

test('applyPlayerControl rejects retired action and seek field aliases', async () => {
  const audio = { paused: false, currentTime: 0, duration: 100 };
  const fixture = makeState({ currentSong: song('a'), audio });

  assert.equal((await applyPlayerControl({ action: 'pause' }, fixture)).error, 'unknown_action');
  assert.equal((await applyPlayerControl({ type: 'seek', action: 'seek_percent', position: 50 }, fixture)).error, 'unknown_action');
  assert.equal((await applyPlayerControl({ type: 'seek', action: 'seek', mode: 'percent', position_percent: 50 }, fixture)).error, 'position_required');
  assert.equal(audio.currentTime, 0);
});

test('play noop still reports the explicit playing state', async () => {
  const audio = {
    paused: false,
    currentTime: 20,
    duration: 100,
    play: async () => {},
    pause() { this.paused = true; },
  };
  const fixture = makeState({ currentSong: song('a'), audio });
  const result = await applyPlayerControl({ type: 'control', action: 'play' }, fixture);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'noop');
  assert.equal(result.playback_state, 'playing');
});

test('toggle returns buffering promptly when resume is still loading', async () => {
  const audio = {
    paused: true,
    currentTime: 0,
    play: () => new Promise(() => {}),
    pause() { this.paused = true; },
  };
  const fixture = makeState({ currentSong: song('a'), audio });
  const result = await applyPlayerControl(
    { type: 'control', action: 'toggle' },
    { ...fixture, playbackObservationMs: 5 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.playback_state, 'buffering');
});

test('applyPlaySongNow hydrates relative media paths against the deployment-local media route', async () => {
  const rawRelativeSong = {
    id: 'rel-1',
    title: 'Relative Song',
    audio_url: 'audio/rel-1.flac',
    cover_url: 'cover/rel-1.jpg',
  };
  const audio = {
    src: 'https://media.example.test/media/audio/rel-1.flac',
    currentTime: 0,
    play: async () => {},
  };
  const fixture = makeState({ playlist: [], currentSong: null, audio });
  const result = await applyPlaySongNow(rawRelativeSong, fixture);
  assert.equal(result.ok, true);
  assert.equal(fixture.state.currentSong.id, 'rel-1');
  assert.equal(fixture.state.currentSong.audio_url, '/media/audio/rel-1.flac');
  assert.equal(fixture.state.currentSong.cover_url, '/media/cover/rel-1.jpg');
});

test('applyRoamControl drives the shared randomRoam state machine with the requested language', () => {
  const calls = [];
  const state = {
    randomRoam: { enabled: false, language: 'all' },
    setRandomRoamEnabled: (enabled, options) => {
      calls.push([enabled, options]);
      state.randomRoam = { enabled, language: options?.language || state.randomRoam.language };
      return true;
    },
  };
  const fixture = { getState: () => state };

  assert.deepEqual(
    applyRoamControl({ action: 'enable', language: 'ja' }, fixture),
    { ok: true, outcome: 'applied', enabled: true, language: 'ja' },
  );
  assert.deepEqual(calls, [[true, { language: 'ja' }]]);

  // 同语种重复开启不重复上报 applied
  assert.equal(applyRoamControl({ action: 'enable', language: 'ja' }, fixture).outcome, 'noop');
  assert.equal(applyRoamControl({ action: 'disable' }, fixture).outcome, 'applied');
  assert.equal(applyRoamControl({ action: 'disable' }, fixture).outcome, 'noop');
  assert.deepEqual(applyRoamControl({ action: 'toggle' }, fixture), { ok: false, outcome: 'ignored' });
  assert.equal(applyRoamControl({ action: 'enable' }, { getState: () => ({}) }).ok, false);
});
