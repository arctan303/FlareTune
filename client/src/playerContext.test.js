import test from 'node:test';
import assert from 'node:assert/strict';
import {
    mergePlayerContextSongMetadata,
    normalizePlayerContext,
    PLAYER_CONTEXT_SCHEMA,
    toCanonicalSong,
} from './playerContext.js';

test('canonical player context preserves only explicit valid language metadata', () => {
  assert.equal(toCanonicalSong({ id: 'song-1', audio_url: 'audio/song-1.mp3', language: 'en' }).language, 'en');
  assert.equal(toCanonicalSong({ id: 'song-2', audio_url: 'audio/song-2.mp3', language: 'instrumental' }).language, 'instrumental');
  assert.equal(toCanonicalSong({ id: 'song-3', audio_url: 'audio/song-3.mp3', language: 'foreign' }).language, null);
});

test('canonical player context does not infer language from legacy lyric fields', () => {
  const song = toCanonicalSong({ id: 'legacy-song', audio_url: 'audio/legacy-song.mp3', has_lyrics: 1, needs_translation: 1 });
  assert.equal(song.language, null);
  assert.equal('has_lyrics' in song, false);
  assert.equal('needs_translation' in song, false);
});

test('canonical player context rejects retired song and context field aliases', () => {
  assert.equal(toCanonicalSong({ songId: 'old', audioUrl: 'audio/old.mp3' }), null);
  assert.equal(toCanonicalSong({ song_id: 'old', audioKey: 'audio/old.mp3' }), null);
  assert.equal(normalizePlayerContext({
    schema: PLAYER_CONTEXT_SCHEMA,
    current_song_id: 'old',
    session_id: 'old-session',
    playlist: [{ id: 'old', audio_url: 'audio/old.mp3', language: 'en' }],
  }), null);
});

test('player context falls back from an incomplete current song to the first playable queue item', () => {
  const context = normalizePlayerContext({
    schema: PLAYER_CONTEXT_SCHEMA,
    currentSongId: 'ghost', sessionId: 'session-1', position: 91, duration: 120,
    queue: [{ id: 'ghost', title: 'Ghost' }, { id: 'valid', title: 'Valid', audio_url: 'audio/valid.mp3', duration: 180, language: 'zh' }],
  });
  assert.equal(context.currentSongId, 'valid');
  assert.equal(context.position, 0);
  assert.equal(context.duration, 180);
  assert.deepEqual(context.queue.map(song => song.id), ['valid']);
});

test('player context removes incomplete queue items while preserving a valid current song', () => {
  const context = normalizePlayerContext({
    schema: PLAYER_CONTEXT_SCHEMA,
    currentSongId: 'valid', sessionId: 'session-1', position: 23, duration: 180,
    queue: [{ id: 'valid', title: 'Valid', audio_url: 'audio/valid.mp3', language: 'ja' }, { id: 'ghost', title: 'Ghost' }],
  });
  assert.equal(context.currentSongId, 'valid');
  assert.equal(context.position, 23);
  assert.deepEqual(context.queue.map(song => song.id), ['valid']);
});

test('player context rejects a queue containing no playable songs or a missing session', () => {
  assert.equal(normalizePlayerContext({ schema: PLAYER_CONTEXT_SCHEMA, currentSongId: 'ghost', sessionId: 'session-1', queue: [{ id: 'ghost', title: 'Ghost' }] }), null);
  assert.equal(normalizePlayerContext({ schema: PLAYER_CONTEXT_SCHEMA, currentSongId: 'valid', queue: [{ id: 'valid', audio_url: 'audio/valid.mp3' }] }), null);
});

test('player context rejects missing and retired schemas instead of repairing them as current', () => {
  const payload = {
    currentSongId: 'valid',
    sessionId: 'session-1',
    queue: [{ id: 'valid', audio_url: 'audio/valid.mp3' }],
  };
  assert.equal(normalizePlayerContext(payload), null);
  assert.equal(normalizePlayerContext({ ...payload, schema: 0 }), null);
  assert.equal(normalizePlayerContext({ ...payload, schema: PLAYER_CONTEXT_SCHEMA })?.schema, PLAYER_CONTEXT_SCHEMA);
});

test('metadata repair merges into the latest concurrent context without reverting queue or playback state', () => {
    const latestContext = normalizePlayerContext({
        schema: PLAYER_CONTEXT_SCHEMA,
        revision: 8,
        currentSongId: 'new-current',
        position: 42,
        duration: 180,
        writer: 'music',
        sessionId: 'new-session',
        updatedAt: 800,
        queue: [
            { id: 'old', title: 'Old local', audio_url: '/old.mp3' },
            { id: 'new-current', title: 'New current', audio_url: '/new.mp3', language: 'ja' },
            { id: 'newly-added', title: 'Added concurrently', audio_url: '/added.mp3', language: 'en' },
        ],
    });
    const merged = mergePlayerContextSongMetadata(latestContext, [{
        id: 'old',
        title: 'Old authoritative',
        artist: 'Artist',
        audio_url: '/old-new.mp3',
        language: 'zh',
    }], 900);

    assert.deepEqual(merged.queue.map((song) => song.id), ['old', 'new-current', 'newly-added']);
    assert.equal(merged.queue[0].title, 'Old local');
    assert.equal(merged.queue[0].audio_url, '/old.mp3');
    assert.equal(merged.queue[0].language, 'zh');
    assert.equal(merged.currentSongId, 'new-current');
    assert.equal(merged.position, 42);
    assert.equal(merged.duration, 180);
    assert.equal(merged.writer, 'music');
    assert.equal(merged.sessionId, 'new-session');
    assert.equal(merged.revision, 9);
    assert.equal(merged.updatedAt, 900);
});

test('metadata repair ignores invalid language and songs absent from the latest queue', () => {
    const latestContext = normalizePlayerContext({
        schema: PLAYER_CONTEXT_SCHEMA,
        revision: 3,
        currentSongId: 'kept',
        position: 9,
        sessionId: 'session-1',
        queue: [{ id: 'kept', audio_url: '/kept.mp3', language: 'ko' }],
    });

    assert.deepEqual(mergePlayerContextSongMetadata(latestContext, [
        { id: 'kept', audio_url: '/changed.mp3', language: null },
        { id: 'removed', audio_url: '/removed.mp3', language: 'en' },
    ]), latestContext);
});
