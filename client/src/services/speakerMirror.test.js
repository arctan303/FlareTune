import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeakerMirror } from './speakerMirror.js';
import { createBackgroundScheduler, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

class NativeAudio extends EventTarget {
  constructor() {
    super(); this.paused = false; this.currentTime = 0; this.volume = 0.4;
    this.nativeCalls = []; this.listeners = new Map();
  }
  addEventListener(name, handler) { super.addEventListener(name, handler); if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler); }
  removeEventListener(name, handler) { super.removeEventListener(name, handler); this.listeners.get(name)?.delete(handler); }
  play() { this.nativeCalls.push('play'); return Promise.resolve(); }
  pause() { this.nativeCalls.push('pause'); }
  load() { this.nativeCalls.push('load'); }
  set src(value) { this.nativeCalls.push(['src', value]); }
  emit(name) { if (name === 'play') this.paused = false; if (name === 'pause' || name === 'ended') this.paused = true; this.dispatchEvent(new Event(name)); }
  get listenerCount() { return [...this.listeners.values()].reduce((total, values) => total + values.size, 0); }
}
const song = (id) => ({ id, audio_url: `/media/${id}.mp3` });

function mirrorHarness({ deferred = false, respond } = {}) {
  const audio = new NativeAudio(), scheduler = createBackgroundScheduler(), calls = [], patches = [];
  const player = { currentSong: song('A') };
  let active = 0, peakActive = 0;
  const request = (action, body) => {
    active++; peakActive = Math.max(peakActive, active);
    const entry = { action, body }; calls.push(entry);
    const result = deferred ? new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; })
      : Promise.resolve(respond?.(action, body) ?? (action === 'state' ? { playback: { matched: true, audioId: player.currentSong.id, positionSeconds: audio.currentTime, volume: 40 } }
        : { outcome: 'sent', playback: { audioId: body.songId || player.currentSong.id } }));
    return result.finally(() => active--);
  };
  const mirror = createSpeakerMirror({ audio, getPlayer: () => player, request,
    onState: (patch) => patches.push(patch), setTimer: scheduler.setTimeout, clearTimer: scheduler.clearTimeout });
  return { audio, scheduler, calls, patches, player, mirror, peakActive: () => peakActive,
    async settle(index, response) { calls[index].resolve(response); await flushBackgroundAsync(); } };
}

test('native play/pause/resume is mirrored without replacing or pausing the local audio stream', async () => {
  const subject = mirrorHarness();
  subject.audio.emit('play'); await flushBackgroundAsync();
  subject.audio.emit('pause'); await flushBackgroundAsync();
  subject.audio.emit('play'); await flushBackgroundAsync();
  assert.deepEqual(subject.calls.map(call => call.action), ['play', 'pause', 'resume']);
  assert.equal(subject.audio.currentTime, 0);
  assert.equal(subject.audio.volume, 0.4);
  assert.deepEqual(subject.audio.nativeCalls, []);
  assert.equal(subject.peakActive(), 1);
  subject.mirror.dispose();
});

test('native queue advance and single-track repeat each dispatch exactly one track', async () => {
  const subject = mirrorHarness();
  subject.audio.emit('play'); await flushBackgroundAsync();
  subject.audio.emit('play'); await flushBackgroundAsync();
  subject.audio.emit('ended'); subject.player.currentSong = song('B');
  subject.audio.emit('play'); await flushBackgroundAsync();
  subject.audio.emit('ended'); subject.audio.currentTime = 0;
  subject.audio.emit('play'); await flushBackgroundAsync();
  assert.deepEqual(subject.calls.filter(call => call.action === 'play').map(call => call.body.songId), ['A', 'B', 'B']);
  assert.deepEqual(subject.audio.nativeCalls, []);
  subject.mirror.dispose();
});

test('seek sends one native request and requires state evidence rather than treating a receipt as success', async () => {
  const subject = mirrorHarness({ respond: (action) => action === 'state'
    ? { playback: { matched: true, audioId: 'A', positionSeconds: 4 } } : undefined });
  await subject.mirror.play(); subject.audio.currentTime = 30;
  subject.audio.emit('seeked'); subject.scheduler.expire(200); await flushBackgroundAsync();
  assert.deepEqual(subject.calls.map(call => call.action), ['play', 'seek', 'state']);
  assert.deepEqual(subject.calls[1].body, { positionSeconds: 30 });
  assert.equal(subject.audio.currentTime, 30, 'a failed confirmation cannot silently move the local player');
  assert.ok(subject.patches.some(patch => patch.error === '跳转指令已发送，音箱未返回可确认的位置。'));
  assert.deepEqual(subject.audio.nativeCalls, []);
  subject.mirror.dispose();
});

test('joining ongoing native playback starts with the proven plain payload then positions separately', async () => {
  const subject = mirrorHarness(); subject.audio.currentTime = 80;
  await subject.mirror.play();
  assert.deepEqual(subject.calls.map(call => call.action), ['play', 'seek']);
  assert.deepEqual(subject.calls[0].body, { songId: 'A' });
  assert.deepEqual(subject.calls[1].body, { positionSeconds: 80 });
  assert.equal(subject.audio.currentTime, 80);
  assert.deepEqual(subject.audio.nativeCalls, []);
  subject.mirror.dispose();
});

test('speaker volume changes are debounced and never write local volume', async () => {
  const subject = mirrorHarness();
  subject.mirror.volume(0.2); subject.mirror.volume(0.7);
  subject.scheduler.expire(400); await flushBackgroundAsync();
  assert.deepEqual(subject.calls.map(call => [call.action, call.body.volume]), [['volume', 70]]);
  assert.equal(subject.audio.volume, 0.4);
  subject.mirror.dispose();
});

test('a volume chosen during an in-flight state read is not reverted by that older device reply', async () => {
  const pending = [];
  const subject = mirrorHarness({ respond: action => action === 'state'
    ? new Promise(resolve => pending.push(resolve)) : undefined });
  const poll = subject.mirror.poll(); await flushBackgroundAsync();
  subject.mirror.volume(0.3);
  pending.shift()({ playback: { matched: true, audioId: 'A', volume: 60 } }); await poll;
  assert.equal(subject.patches.some(patch => patch.speakerVolume === 0.6), false);
  subject.scheduler.expire(400); await flushBackgroundAsync();
  assert.deepEqual(subject.calls.filter(call => call.action === 'volume').map(call => call.body.volume), [30]);
  const next = subject.mirror.poll(); await flushBackgroundAsync();
  pending.shift()({ playback: { matched: true, audioId: 'A', volume: 30 } }); await next;
  assert.equal(subject.patches.at(-1).speakerVolume, 0.3, 'a read that starts after the change applies normally');
  subject.mirror.dispose();
});

test('a volume change cancelled by a non-MP3 track does not block later device volume reads', async () => {
  const subject = mirrorHarness();
  await subject.mirror.play();
  subject.mirror.volume(0.3);
  subject.player.currentSong = { id: 'F', audio_url: '/media/F.flac' };
  subject.audio.emit('play'); await flushBackgroundAsync();
  subject.scheduler.expire(400); await flushBackgroundAsync();
  assert.equal(subject.calls.some(call => call.action === 'volume'), false, 'the cancelled change is never sent');
  await subject.mirror.poll();
  assert.equal(subject.patches.at(-1).speakerVolume, 0.4, 'the next reading shows the real device volume');
  subject.mirror.dispose();
});

test('a later successful state read clears a transient polling failure without replaying the song', async () => {
  let reads = 0;
  const subject = mirrorHarness({ respond: action => action === 'state' && ++reads === 1
    ? Promise.reject(Object.assign(new Error('upstream unavailable'), { status: 502 })) : undefined });
  await subject.mirror.play(); await subject.mirror.poll();
  assert.equal(subject.patches.at(-1).phase, 'disconnected');
  await subject.mirror.poll();
  assert.ok(subject.patches.some(patch => patch.phase === 'playing' && patch.error === ''));
  assert.equal(subject.calls.filter(call => call.action === 'play').length, 1);
  assert.deepEqual(subject.audio.nativeCalls, []);
  subject.mirror.dispose();
});

test('rapid song selection invalidates old responses and serializes the remaining requests', async () => {
  const subject = mirrorHarness({ deferred: true });
  const first = subject.mirror.play(); await flushBackgroundAsync();
  subject.player.currentSong = song('B'); const second = subject.mirror.play();
  subject.player.currentSong = song('C'); const third = subject.mirror.play();
  assert.equal(subject.calls.length, 1);
  await subject.settle(0, { outcome: 'sent', playback: { audioId: 'A' } });
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(subject.calls.length, 2);
  assert.equal(subject.calls[1].body.songId, 'C');
  await subject.settle(1, { outcome: 'sent', playback: { audioId: 'C' } });
  assert.equal(await third, true);
  assert.equal(subject.peakActive(), 1);
  assert.deepEqual(subject.calls.map(call => call.body.songId), ['A', 'C']);
  subject.mirror.dispose();
});

test('an ambiguous play is never retried automatically, while a later native pause is still forwarded', async () => {
  const subject = mirrorHarness({ respond: (action) => action === 'play' ? { outcome: 'uncertain' } : undefined });
  subject.audio.emit('play'); await flushBackgroundAsync();
  subject.scheduler.expire(200); subject.scheduler.expire(400); await flushBackgroundAsync();
  assert.deepEqual(subject.calls.map(call => call.action), ['play']);
  assert.ok(subject.patches.some(patch => patch.phase === 'uncertain'));
  subject.audio.emit('pause'); await flushBackgroundAsync();
  assert.deepEqual(subject.calls.map(call => call.action), ['play', 'pause']);
  subject.mirror.dispose();
});

test('a lost play response is reported as uncertain and never automatically retried', async () => {
  const subject = mirrorHarness({ respond: (action) => action === 'play'
    ? Promise.reject(Object.assign(new Error('network lost after dispatch'), { status: 0, code: 'network_unavailable' })) : undefined });
  await subject.mirror.play();
  subject.scheduler.expire(200); subject.scheduler.expire(400); await flushBackgroundAsync();
  assert.deepEqual(subject.calls.map(call => call.action), ['play']);
  assert.ok(subject.patches.some(patch => patch.phase === 'uncertain' && /避免重复播放/u.test(patch.error || '')),
    'a lost receipt cannot safely instruct the user to send the same play again');
  subject.mirror.dispose();
});

test('disposing removes native listeners and cancels pending seek/volume work and queued requests', async () => {
  const subject = mirrorHarness(); await subject.mirror.play();
  subject.audio.currentTime = 20; subject.audio.emit('seeked'); subject.mirror.volume(0.9);
  assert.equal(subject.audio.listenerCount, 4);
  const count = subject.calls.length;
  subject.mirror.dispose();
  assert.equal(subject.audio.listenerCount, 0);
  assert.equal(subject.scheduler.timeouts.size, 0);
  subject.audio.emit('play'); subject.audio.emit('pause');
  subject.scheduler.expire(200); subject.scheduler.expire(400); await flushBackgroundAsync();
  assert.equal(subject.calls.length, count);
});

test('a delayed play cannot reclaim playing state after native selection moves to non-MP3, including ended transitions', async () => {
  for (const ended of [false, true]) {
    const subject = mirrorHarness({ deferred: true });
    const first = subject.mirror.play(); await flushBackgroundAsync();
    if (ended) subject.audio.emit('ended');
    subject.player.currentSong = { id: 'FLAC', audio_url: '/media/FLAC.flac' };
    const unsupported = subject.mirror.play();
    await subject.settle(0, { outcome: 'sent', playback: { audioId: 'A' } });
    assert.equal(await first, false);
    assert.deepEqual(subject.calls.map(call => call.action), ['play', 'stop']);
    assert.equal(subject.peakActive(), 1, 'the stop must wait until the old request settles');
    assert.equal(subject.patches.some(patch => patch.phase === 'playing'), false,
      'a late receipt cannot restore the old track after the native player has moved on');
    await subject.settle(1, { outcome: 'sent' });
    assert.equal(await unsupported, false);
    assert.ok(subject.patches.some(patch => /不是 MP3/u.test(patch.error || '')));
    subject.mirror.dispose();
  }
});

test('an uncertain pause still allows a later explicit native play to send resume once', async () => {
  const subject = mirrorHarness({ respond: action => action === 'pause' ? { outcome: 'uncertain' } : undefined });
  await subject.mirror.play();
  subject.audio.emit('pause'); await flushBackgroundAsync();
  assert.ok(subject.patches.some(patch => patch.phase === 'uncertain'));
  subject.audio.emit('play'); await flushBackgroundAsync();
  assert.deepEqual(subject.calls.map(call => call.action), ['play', 'pause', 'resume']);
  assert.equal(subject.calls.filter(call => call.action === 'resume').length, 1);
  subject.mirror.dispose();
});

test('external playback ownership suspends all further mirrored controls and mode exit does not stop the external source', async () => {
  const subject = mirrorHarness({ respond: action => action === 'state'
    ? { playback: { matched: false, audioId: 'external-source', volume: 20 } } : undefined });
  await subject.mirror.play(); await subject.mirror.poll();
  assert.ok(subject.patches.some(patch => patch.phase === 'suspended'));
  const count = subject.calls.length;
  subject.audio.emit('pause'); subject.audio.currentTime = 40; subject.audio.emit('seeked');
  subject.mirror.volume(0.9); subject.player.currentSong = song('B'); subject.audio.emit('play');
  subject.scheduler.expire(200); subject.scheduler.expire(400); await flushBackgroundAsync();
  assert.equal(subject.calls.length, count, 'pause, seek, volume and next-track events cannot take the speaker back');
  assert.equal(await subject.mirror.stop(), true);
  assert.equal(subject.calls.length, count, 'closing output must not stop another source');
  subject.mirror.dispose();
});

test('a delayed seek confirmation cannot overwrite the next track state or suspend it using an old mismatch', async () => {
  const subject = mirrorHarness({ deferred: true });
  const first = subject.mirror.play(); await flushBackgroundAsync();
  await subject.settle(0, { outcome: 'sent', playback: { audioId: 'A' } }); await first;
  subject.audio.currentTime = 30; subject.audio.emit('seeked'); subject.scheduler.expire(200); await flushBackgroundAsync();
  assert.equal(subject.calls[1].action, 'seek');
  await subject.settle(1, { outcome: 'sent' });
  assert.equal(subject.calls[2].action, 'state');
  subject.player.currentSong = song('B'); subject.audio.currentTime = 0;
  const next = subject.mirror.play(), patchIndex = subject.patches.length;
  await subject.settle(2, { playback: { matched: false, audioId: 'external-source', volume: 99, positionSeconds: 2 } });
  assert.equal(subject.calls[3].action, 'play');
  assert.equal(subject.calls[3].body.songId, 'B');
  await subject.settle(3, { outcome: 'sent', playback: { audioId: 'B' } });
  assert.equal(await next, true);
  const afterSwitch = subject.patches.slice(patchIndex);
  assert.equal(afterSwitch.some(patch => patch.phase === 'suspended' || patch.speakerVolume === 0.99 || /未确认跳转/u.test(patch.error || '')), false);
  assert.ok(afterSwitch.some(patch => patch.phase === 'playing'));
  assert.equal(Object.assign({}, ...subject.patches).phase, 'playing');
  assert.equal(subject.peakActive(), 1);
  subject.mirror.dispose();
});

test('explicit native play may retry a definite refusal, while a lost receipt still suppresses duplicate playback', async () => {
  for (const kind of ['failed', 'busy409', 'networkLost']) {
    let attempts = 0;
    const subject = mirrorHarness({ respond: action => {
      if (action !== 'play' || ++attempts > 1) return undefined;
      if (kind === 'failed') return { outcome: 'failed' };
      return Promise.reject(Object.assign(new Error(kind), kind === 'busy409'
        ? { status: 409, code: 'SPEAKER_BUSY' } : { status: 0, code: 'network_unavailable' }));
    } });
    subject.audio.emit('play'); await flushBackgroundAsync();
    subject.scheduler.expire(200); subject.scheduler.expire(400); await flushBackgroundAsync();
    assert.equal(subject.calls.length, 1, `${kind}: no response may trigger an automatic retry`);
    subject.audio.emit('play'); await flushBackgroundAsync();
    assert.deepEqual(subject.calls.map(call => call.action), kind === 'networkLost' ? ['play'] : ['play', 'play'],
      `${kind}: only a definite refusal permits another explicit native play`);
    if (kind === 'networkLost') assert.ok(subject.patches.some(patch => patch.phase === 'uncertain'));
    else assert.equal(Object.assign({}, ...subject.patches).phase, 'playing');
    subject.mirror.dispose();
  }
});
