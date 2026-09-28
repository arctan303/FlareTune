import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getCurrentPlaybackTool } from './getCurrentPlayback.js';
import { musicQueryTool } from './musicQuery.js';
import { musicControlTool } from './musicControl.js';
import { playerQueueTool } from './playerQueue.js';
import { playerSeekTool } from './playerSeek.js';

const activeTools = new Map([
  getCurrentPlaybackTool,
  musicQueryTool,
  musicControlTool,
  playerQueueTool,
  playerSeekTool,
].map((tool) => [tool.name, tool]));

const executeActiveTool = (name, args, context) => {
  const tool = activeTools.get(name);
  assert.ok(tool, 'expected a current assistant tool');
  return tool.execute(args, context);
};

const MEMBER = { subject: 'member-test' };
const playableSong = (id, title = id) => ({
  id,
  title,
  artist: 'Artist',
  album: 'Album',
  duration: 180,
  audio_url: `audio/${id}.mp3`,
  cover_url: `cover/${id}.jpg`,
  has_lyrics: 1,
  needs_translation: 0,
});

const assertGeneratedPlayerInstruction = (response) => {
  assert.equal(response.eventData.instruction_status, 'generated');
  assert.equal(response.eventData.browser_execution, 'unknown');
  assert.match(response.summary, /播放器指令已生成/);
  assert.match(response.modelText, /播放器指令已生成，浏览器执行结果未知/);
  for (const visibleValue of [response.summary, response.modelText]) {
    assert.doesNotMatch(visibleValue, /正在播放|已向播放器发送|已将.*插播|已向播放队列追加|已换上|已跳转播放进度/);
  }
};

test('get_current_playback returns the actual player snapshot when available', async () => {
  const song = playableSong('now', 'Now Playing');
  const res = await executeActiveTool('get_current_playback', {}, {
    user: MEMBER,
    currentSong: song,
    playbackState: {
      isPlaying: false,
      isBuffering: true,
      progress: 42.5,
      duration: 180,
      playMode: 'loop',
      queueLength: 7,
      currentIndex: 2,
    },
  });
  assert.match(res.modelText, /Now Playing/);
  assert.match(res.modelText, /播放状态：缓冲中（43s \/ 180s，24%）/);
  assert.match(res.modelText, /播放模式：loop/);
  assert.match(res.modelText, /队列位置：第 2 首 \/ 共 7 首/);
  assert.match(res.summary, /缓冲中/);
});

test('get_current_playback handles a missing playback snapshot without fabricating state', async () => {
  const res = await executeActiveTool('get_current_playback', {}, {
    user: MEMBER,
    currentSong: playableSong('legacy', 'Legacy Song'),
  });
  assert.match(res.modelText, /Legacy Song/);
  assert.match(res.modelText, /播放状态：状态未知/);
  assert.match(res.summary, /状态未知/);
});

test('get_current_playback returns upcoming queue when include_queue is true with capped limit', async () => {
  const song = playableSong('current', 'Current Track');
  const res = await executeActiveTool('get_current_playback', { include_queue: true, queue_limit: 2 }, {
    user: MEMBER,
    currentSong: song,
    playbackState: {
      isPlaying: true,
      isBuffering: false,
      progress: 60,
      duration: 200,
      playMode: 'sequence',
      queueLength: 50,
      currentIndex: 1,
      upcomingSongs: [
        { id: 'next_1', title: 'Next 1', artist: 'Artist 1' },
        { id: 'next_2', title: 'Next 2', artist: 'Artist 2' },
        { id: 'next_3', title: 'Next 3', artist: 'Artist 3' },
        { id: 'next_4', title: 'Next 4', artist: 'Artist 4' },
      ],
    },
  });
  assert.match(res.modelText, /播放状态：播放中（60s \/ 200s，30%）/);
  assert.match(res.modelText, /即将播放：/);
  assert.match(res.modelText, /《Next 1》/);
  assert.match(res.modelText, /《Next 2》/);
  assert.doesNotMatch(res.modelText, /《Next 3》/);
});

test('get_current_playback handles stopped player without active song', async () => {
  const res = await executeActiveTool('get_current_playback', {}, {
    user: MEMBER,
    currentSong: null,
    playbackState: {
      isPlaying: false,
      isBuffering: false,
      progress: 0,
      duration: 0,
      playMode: 'sequence',
      queueLength: 0,
      currentIndex: null,
    },
  });
  assert.match(res.modelText, /听众当前未在播放任何歌曲/);
  assert.match(res.modelText, /播放器状态：已暂停/);
  assert.equal(res.summary, '当前无播放曲目');
});

test('music_query search ignores ASCII case and whitespace layout differences', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY,
      title TEXT,
      artist TEXT,
      album TEXT,
      duration INTEGER,
      audio_url TEXT,
      cover_url TEXT,
      has_lyrics INTEGER,
      needs_translation INTEGER,
      language TEXT DEFAULT NULL
    );
    INSERT INTO Songs (id, title, artist, album, duration, audio_url, cover_url, has_lyrics, needs_translation) VALUES
      ('la-la-la', 'La La La', 'Naughty Boy', 'Hotel Cabana', 180, 'audio/la-la-la.mp3', NULL, 1, 0),
      ('artist-match', 'Unity', 'The Fat Rat', 'Monody Collection', 240, 'audio/unity.mp3', NULL, 1, 0),
      ('album-match', 'City of Stars', 'Ryan Gosling', 'La La Land', 210, 'audio/city-of-stars.mp3', NULL, 1, 0);
  `);
  const db = {
    prepare: (statement) => {
      const prepared = sqlite.prepare(statement);
      return {
        bind: (...values) => ({
          all: async () => ({ results: prepared.all(...values) }),
        }),
      };
    },
  };

  const compact = await executeActiveTool('music_query', { action: 'search', keyword: 'lalala' }, { db, user: MEMBER });
  const spaced = await executeActiveTool('music_query', { action: 'search', keyword: 'LA  LA  LA' }, { db, user: MEMBER });
  const artist = await executeActiveTool('music_query', { action: 'search', keyword: 'thefatrat' }, { db, user: MEMBER });
  const album = await executeActiveTool('music_query', { action: 'search', keyword: 'lalaland' }, { db, user: MEMBER });

  assert.equal(compact.eventData.songs.find((song) => song.id === 'la-la-la')?.title, 'La La La');
  assert.match(compact.modelText, /\]\(song:la-la-la\)/);
  assert.equal(spaced.eventData.songs.find((song) => song.id === 'la-la-la')?.title, 'La La La');
  assert.equal(artist.eventData.songs[0].artist, 'The Fat Rat');
  assert.equal(album.eventData.songs[0].album, 'La La Land');
  sqlite.close();
});

test('assistant music search and direct playback resolve Japanese kana from romaji', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
      duration INTEGER, audio_url TEXT, cover_url TEXT, language TEXT);
    INSERT INTO Songs (id, title, artist, audio_url, language) VALUES
      ('ja-song', 'はいよろこんで', 'こっちのけんと', '/ja.mp3', 'ja');
  `);
  const db = {
    prepare(sql) {
      const prepared = sqlite.prepare(sql);
      return {
        bind(...values) { return {
          all: async () => ({ results: prepared.all(...values) }),
          first: async () => prepared.get(...values),
        }; },
      };
    },
  };
  try {
    const search = await executeActiveTool('music_query', {
      action: 'search', keyword: 'haiyorokonde', language: 'ja',
    }, { db, user: MEMBER });
    assert.equal(search.eventData.songs[0]?.id, 'ja-song');
    const play = await executeActiveTool('music_control', {
      action: 'play_song', song_name: 'haiyorokonde',
    }, { db, user: MEMBER });
    assert.equal(play.playerAction?.song?.id, 'ja-song');
  } finally { sqlite.close(); }
});
test('player_queue emits playerAction for insert_next', async () => {
  const mockDb = {
    prepare: () => ({
      bind: () => ({
        first: async () => playableSong('song_99', '晴天')
      })
    })
  };

  const res = await executeActiveTool('player_queue', { action: 'insert_next', song_ids: ['song_99'] }, { db: mockDb, user: MEMBER });
  assert.equal(res.playerAction?.type, 'insert_next');
  assert.equal(res.playerAction?.song.title, '晴天');
  assert.equal(res.playerAction?.song.audio_url, 'audio/song_99.mp3');
  assert.ok(res.summary.includes('晴天'));
  assertGeneratedPlayerInstruction(res);
});

test('player_queue replace emits playable songs in requested id order', async () => {
  const mockDb = {
    prepare: () => ({
      bind: (id) => ({
        first: async () => playableSong(id, id === 's1' ? 'Track 1' : 'Track 2'),
      }),
    })
  };

  const res = await executeActiveTool('player_queue', { action: 'replace', song_ids: ['s1', 's2'] }, { db: mockDb, user: MEMBER });
  assert.equal(res.playerAction?.type, 'replace_queue');
  assert.equal(res.playerAction?.songs.length, 2);
  assert.deepEqual(res.playerAction?.songs.map(song => song.id), ['s1', 's2']);
  assert.deepEqual(res.playerAction?.requestedSongIds, ['s1', 's2']);
  assert.deepEqual(res.playerAction?.missingSongIds, []);
  assert.ok(res.playerAction?.songs.every(song => song.audio_url));
  assert.match(res.summary, /播放队列/);
  assertGeneratedPlayerInstruction(res);
});

test('player_queue preserves requested and missing ids in playerAction', async () => {
  const mockDb = {
    prepare: () => ({
      bind: (id) => ({
        first: async () => id === 's1' ? playableSong('s1', 'Track 1') : null,
      }),
    }),
  };
  const res = await executeActiveTool('player_queue', {
    action: 'replace',
    song_ids: ['s1', 'missing', 's2'],
  }, { db: mockDb, user: MEMBER });
  assert.deepEqual(res.playerAction.requestedSongIds, ['s1', 'missing', 's2']);
  assert.deepEqual(res.playerAction.missingSongIds, ['missing', 's2']);
  assert.deepEqual(res.playerAction.songs.map((song) => song.id), ['s1']);
  assertGeneratedPlayerInstruction(res);
});

test('music_control reports generated instructions without claiming browser execution', async () => {
  const control = await executeActiveTool('music_control', { action: 'pause' }, { user: MEMBER });
  assert.deepEqual(control.playerAction, { type: 'control', action: 'pause' });
  assertGeneratedPlayerInstruction(control);

  const mockDb = {
    prepare: () => ({
      bind: () => ({ first: async () => playableSong('song_1', '晴天') }),
    }),
  };
  const playSong = await executeActiveTool('music_control', { action: 'play_song', song_id: 'song_1' }, { db: mockDb, user: MEMBER });
  assert.equal(playSong.playerAction?.type, 'play_now');
  assert.equal(playSong.playerAction?.song.title, '晴天');
  assertGeneratedPlayerInstruction(playSong);
});

test('player_seek reports a generated instruction while preserving playerAction semantics', async () => {
  const seconds = await executeActiveTool('player_seek', { position: 42, mode: 'seconds' }, { user: MEMBER });
  assert.deepEqual(seconds.playerAction, {
    type: 'seek',
    action: 'seek',
    mode: 'seconds',
    position: 42,
  });
  assertGeneratedPlayerInstruction(seconds);

  const percent = await executeActiveTool('player_seek', { position: 25, mode: 'percent' }, { user: MEMBER });
  assert.equal(percent.playerAction?.mode, 'percent');
  assert.equal(percent.playerAction?.position, 25);
  assertGeneratedPlayerInstruction(percent);

  for (const retiredArgs of [
    { seconds: 42 },
    { percent: 25 },
    { position_seconds: 42 },
    { position_percent: 25 },
    { action: 'seek_percent', position: 25 },
  ]) {
    const response = await executeActiveTool('player_seek', retiredArgs, { user: MEMBER });
    if (Object.hasOwn(retiredArgs, 'position')) {
      assert.equal(response.playerAction?.mode, 'seconds');
      assert.equal(response.playerAction?.position, 25);
    } else {
      assert.equal(response.eventData.ok, false);
      assert.equal(response.eventData.error, 'invalid_position');
    }
  }
});

test('music_query random uses the full authenticated library without playlist visibility preference', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
      duration INTEGER, audio_url TEXT, cover_url TEXT,
      has_lyrics INTEGER, needs_translation INTEGER,
      language TEXT DEFAULT NULL
    );
    CREATE TABLE Playlist_Songs (playlist_id TEXT, song_id TEXT, sort_order INTEGER);
    CREATE TABLE Playlists (id TEXT PRIMARY KEY);
    INSERT INTO Songs (id, title, artist, album, duration, audio_url, cover_url, has_lyrics, needs_translation) VALUES
      ('pub-1', 'Public One', 'A', 'X', 180, 'audio/pub-1.mp3', NULL, 1, 0),
      ('pub-2', 'Public Two', 'A', 'X', 180, 'audio/pub-2.mp3', NULL, 1, 0),
      ('un-1', 'Unlisted One', 'B', 'Y', 180, 'audio/un-1.mp3', NULL, 1, 0),
      ('un-2', 'Unlisted Two', 'B', 'Y', 180, 'audio/un-2.mp3', NULL, 1, 0),
      ('un-3', 'Unlisted Three', 'B', 'Y', 180, 'audio/un-3.mp3', NULL, 1, 0);
    INSERT INTO Playlist_Songs VALUES
      ('liked', 'pub-1', 0), ('liked', 'pub-2', 1);
    INSERT INTO Playlists VALUES ('liked');
  `);
  const db = {
    prepare: (statement) => {
      const prepared = sqlite.prepare(statement);
      return {
        bind: (...values) => ({
          all: async () => ({ results: prepared.all(...values) }),
        }),
      };
    },
  };

  // 小批量随机只要求不重复，不再按旧版歌单可见性归属偏置。
  const res = await executeActiveTool('music_query', { action: 'random', count: 3 }, { db, user: MEMBER });
  assert.equal(res.eventData.songs.length, 3);
  assert.equal(new Set(res.eventData.songs.map((song) => song.id)).size, 3);

  // count 超过曲库规模时返回完整可播放集合。
  const fillRes = await executeActiveTool('music_query', { action: 'random', count: 10 }, { db, user: MEMBER });
  assert.equal(fillRes.eventData.songs.length, 5);
  assert.deepEqual(new Set(fillRes.eventData.songs.map((song) => song.id)), new Set(['pub-1', 'pub-2', 'un-1', 'un-2', 'un-3']));
  assert.equal(Object.hasOwn(musicQueryTool.parameters.properties, 'prefer_unlisted'), false);
  sqlite.close();
});
test('music_query random ignores retired playlist visibility metadata', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
      duration INTEGER, audio_url TEXT, cover_url TEXT,
      has_lyrics INTEGER, needs_translation INTEGER,
      language TEXT DEFAULT NULL
    );
    CREATE TABLE Playlist_Songs (playlist_id TEXT, song_id TEXT, sort_order INTEGER);
    INSERT INTO Songs (id, title, artist, album, duration, audio_url, cover_url, has_lyrics, needs_translation) VALUES
      ('pub-1', 'Public One', 'A', 'X', 180, 'audio/pub-1.mp3', NULL, 1, 0),
      ('un-1', 'Unlisted One', 'B', 'Y', 180, 'audio/un-1.mp3', NULL, 1, 0);
    INSERT INTO Playlist_Songs VALUES ('liked', 'pub-1', 0);
  `);
  const db = {
    prepare: (statement) => {
      const prepared = sqlite.prepare(statement);
      return {
        bind: (...values) => ({
          all: async () => ({ results: prepared.all(...values) }),
        }),
      };
    },
  };

  const res = await executeActiveTool('music_query', { action: 'random', count: 5, prefer_unlisted: false }, { db, user: MEMBER });
  assert.equal(res.eventData.songs.length, 2);
  sqlite.close();
});

test('music_query random excludes requested song ids', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
      duration INTEGER, audio_url TEXT, cover_url TEXT,
      has_lyrics INTEGER, needs_translation INTEGER,
      language TEXT DEFAULT NULL
    );
    CREATE TABLE Playlist_Songs (playlist_id TEXT, song_id TEXT, sort_order INTEGER);
    CREATE TABLE Playlists (id TEXT PRIMARY KEY);
    INSERT INTO Songs (id, title, artist, album, duration, audio_url, cover_url, has_lyrics, needs_translation) VALUES
      ('un-1', 'Unlisted One', 'B', 'Y', 180, 'audio/un-1.mp3', NULL, 1, 0),
      ('un-2', 'Unlisted Two', 'B', 'Y', 180, 'audio/un-2.mp3', NULL, 1, 0),
      ('un-3', 'Unlisted Three', 'B', 'Y', 180, 'audio/un-3.mp3', NULL, 1, 0);
    INSERT INTO Playlist_Songs VALUES ('liked', 'pub-1', 0);
    INSERT INTO Playlists VALUES ('liked');
  `);
  const db = {
    prepare: (statement) => {
      const prepared = sqlite.prepare(statement);
      return {
        bind: (...values) => ({
          all: async () => ({ results: prepared.all(...values) }),
        }),
      };
    },
  };

  const res = await executeActiveTool('music_query', {
    action: 'random',
    count: 999,
    exclude_ids: ['un-1', 'un-2'],
  }, { db, user: MEMBER });
  assert.equal(res.eventData.songs.length, 1);
  assert.equal(res.eventData.songs[0].id, 'un-3');
  sqlite.close();
});

test('music_query random clamps count at 10 with enough playable songs', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
      duration INTEGER, audio_url TEXT, cover_url TEXT,
      has_lyrics INTEGER, needs_translation INTEGER,
      language TEXT DEFAULT NULL
    );
    CREATE TABLE Playlist_Songs (playlist_id TEXT, song_id TEXT, sort_order INTEGER);
    CREATE TABLE Playlists (id TEXT PRIMARY KEY);
  `);
  const stmt = sqlite.prepare(
    'INSERT INTO Songs (id, title, artist, album, duration, audio_url, cover_url, has_lyrics, needs_translation) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 0)',
  );
  for (let i = 0; i < 60; i += 1) {
    stmt.run(`song-${String(i).padStart(2, '0')}`, `Song ${i}`, 'Artist', 'Album', 180, `audio/song-${i}.mp3`);
  }
  const db = {
    prepare: (statement) => {
      const prepared = sqlite.prepare(statement);
      return {
        bind: (...values) => ({
          all: async () => ({ results: prepared.all(...values) }),
        }),
      };
    },
  };

  // 60 首可播放曲目（不依赖歌单归属），count 超上限时应恰好返回 10
  const res = await executeActiveTool('music_query', { action: 'random', count: 60 }, { db, user: MEMBER });
  assert.equal(res.eventData.songs.length, 10);
  const uniqueIds = new Set(res.eventData.songs.map((song) => song.id));
  assert.equal(uniqueIds.size, 10);
  sqlite.close();
});

test('music_query search applies count clamp between 1 and 10', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
      duration INTEGER, audio_url TEXT, cover_url TEXT,
      has_lyrics INTEGER, needs_translation INTEGER,
      language TEXT DEFAULT NULL
    );
  `);
  const stmt = sqlite.prepare(
    'INSERT INTO Songs (id, title, artist, album, duration, audio_url, cover_url, has_lyrics, needs_translation) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 0)',
  );
  for (let i = 0; i < 60; i += 1) {
    stmt.run(`m-${String(i).padStart(2, '0')}`, `Match ${i}`, 'Artist', 'Album', 180, `audio/m-${i}.mp3`);
  }
  const db = {
    prepare: (statement) => {
      const prepared = sqlite.prepare(statement);
      return {
        bind: (...values) => ({
          all: async () => ({ results: prepared.all(...values) }),
        }),
      };
    },
  };

  // count 超过上限时 clamp 到 10
  const big = await executeActiveTool('music_query', { action: 'search', keyword: 'Match', count: 999 }, { db, user: MEMBER });
  assert.equal(big.eventData.songs.length, 10);
  // count 低于下限时 clamp 到 1
  const tiny = await executeActiveTool('music_query', { action: 'search', keyword: 'Match', count: -10 }, { db, user: MEMBER });
  assert.equal(tiny.eventData.songs.length, 1);
  sqlite.close();
});

test('music_query returns search data without a reply-card presentation option', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
      duration INTEGER, audio_url TEXT, cover_url TEXT,
      has_lyrics INTEGER, needs_translation INTEGER,
      language TEXT DEFAULT NULL
    );
    INSERT INTO Songs (id, title, artist, album, duration, audio_url, cover_url, has_lyrics, needs_translation) VALUES
      ('m-1', 'Match One', 'Artist', 'Album', 180, 'audio/m-1.mp3', NULL, 1, 0),
      ('m-2', 'Match Two', 'Artist', 'Album', 180, 'audio/m-2.mp3', NULL, 1, 0);
  `);
  const db = {
    prepare: (statement) => {
      const prepared = sqlite.prepare(statement);
      return {
        bind: (...values) => ({
          all: async () => ({ results: prepared.all(...values) }),
        }),
      };
    },
  };

  const result = await executeActiveTool('music_query', { action: 'search', keyword: 'Match' }, { db, user: MEMBER });
  assert.equal(result.eventData.ok, true);
  assert.equal(result.eventData.type, 'music_cards');
  assert.equal(result.eventData.songs.length, 2);
  assert.equal(Object.hasOwn(result.eventData, 'present'), false);
  assert.equal(Object.hasOwn(musicQueryTool.parameters.properties, 'present'), false);
  sqlite.close();
});

test('music_query filters songs by language in search and random actions', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY,
      title TEXT,
      artist TEXT,
      album TEXT,
      duration INTEGER,
      audio_url TEXT,
      cover_url TEXT,
      has_lyrics INTEGER,
      needs_translation INTEGER,
      language TEXT DEFAULT NULL
    );
    CREATE TABLE Playlists (id TEXT PRIMARY KEY);
    CREATE TABLE Playlist_Songs (playlist_id TEXT, song_id TEXT);
    INSERT INTO Songs (id, title, artist, album, duration, audio_url, cover_url, has_lyrics, needs_translation, language) VALUES
      ('s_zh', '晴天', '周杰伦', '精选集', 269, 'audio/zh.mp3', NULL, 1, 0, 'zh'),
      ('s_ja', 'Lemon', '米津玄師', '精选集', 255, 'audio/ja.mp3', NULL, 1, 0, 'ja'),
      ('s_inst', 'Summer', '久石让', '精选集', 180, 'audio/inst.mp3', NULL, 0, 0, 'instrumental');
  `);
  const db = {
    prepare: (statement) => {
      const prepared = sqlite.prepare(statement);
      return {
        bind: (...values) => ({
          all: async () => ({ results: prepared.all(...values) }),
          first: async () => prepared.get(...values) || null,
        }),
        all: async () => ({ results: prepared.all() }),
        first: async () => prepared.get() || null,
      };
    },
  };

  const context = { db, user: { subject: 'test-user' } };

  // 1. search with keyword: '精选集' and language: 'zh'
  const zhRes = await executeActiveTool('music_query', { action: 'search', keyword: '精选集', language: 'zh' }, context);
  const zhParsed = zhRes.eventData;
  assert.equal(zhParsed.songs.length, 1);
  assert.equal(zhParsed.songs[0].id, 's_zh');

  // 2. search with keyword: '精选集' and language: 'ja'
  const jaRes = await executeActiveTool('music_query', { action: 'search', keyword: '精选集', language: 'ja' }, context);
  const jaParsed = jaRes.eventData;
  assert.equal(jaParsed.songs.length, 1);
  assert.equal(jaParsed.songs[0].id, 's_ja');

  // 3. search with keyword: '精选集' and language: 'instrumental'
  const instRes = await executeActiveTool('music_query', { action: 'search', keyword: '精选集', language: 'instrumental' }, context);
  const instParsed = instRes.eventData;
  assert.equal(instParsed.songs.length, 1);
  assert.equal(instParsed.songs[0].id, 's_inst');

  // 4. search with keyword: '精选集' without language filter -> returns all 3
  const allRes = await executeActiveTool('music_query', { action: 'search', keyword: '精选集' }, context);
  const allParsed = allRes.eventData;
  assert.equal(allParsed.songs.length, 3);

  // 5. random with language: 'ja'
  const randomJaRes = await executeActiveTool('music_query', { action: 'random', count: 5, language: 'ja' }, context);
  const randomJaParsed = randomJaRes.eventData;
  assert.equal(randomJaParsed.songs.length, 1);
  assert.equal(randomJaParsed.songs[0].id, 's_ja');

  sqlite.close();
});
