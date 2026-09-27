import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  handleResolveSongs,
  handleSearchSongs,
  handleRandomSongs,
  handleSpotlightArtist,
  parseSpotlightExcludeArtists,
  handleRandomRoam,
  handleGetSongsByLanguage,
  handleGetSongLanguageCounts,
  normalizeRandomRoamSeenIds,
  parseRoamBatchLimit,
} from './songs.js';
import { EXTENDED_SONG_LANGUAGES } from '../utils/songLanguage.js';

const HEADERS = { 'Content-Type': 'application/json' };

const makeRequest = (body) => new Request('https://example.test/api/songs/resolve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const createDb = (songs) => ({
  prepare() {
    return {
      bind(...ids) {
        return {
          async all() {
            return { results: songs.filter((song) => ids.includes(song.id) && song.audio_url) };
          },
        };
      },
    };
  },
});

test('resolve songs preserves requested order and reports missing or unplayable ids', async () => {
  const db = createDb([
    { id: 'one', title: 'One', audio_url: '/one.mp3', language: 'zh' },
    { id: 'two', title: 'Two', audio_url: '/two.mp3', language: 'en' },
    { id: 'silent', title: 'Silent', audio_url: '' },
  ]);
  const response = await handleResolveSongs(
    makeRequest({ song_ids: ['two', 'missing', 'one', 'two', 'silent'] }),
    db,
    HEADERS,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.data.songs.map((song) => song.id), ['two', 'one']);
  assert.deepEqual(payload.data.songs.map((song) => song.language), ['en', 'zh']);
  assert.deepEqual(payload.data.missing_ids, ['missing', 'silent']);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});

test('resolve songs accepts only canonical song ids and never title-matches missing ids', async () => {
  const queries = [];
  const db = {
    prepare(sql) {
      queries.push(sql);
      return {
        bind(...args) {
          return {
            async all() {
              return { results: args.includes('id-known') ? [{ id: 'id-known', title: 'Known', audio_url: '/known.mp3' }] : [] };
            },
          };
        },
      };
    },
  };
  const response = await handleResolveSongs(
    makeRequest({ song_ids: ['id-known', '《The Nights》', 'non-existent'] }),
    db,
    HEADERS,
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.data.songs.map((s) => s.id), ['id-known']);
  assert.deepEqual(payload.data.missing_ids, ['《The Nights》', 'non-existent']);
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0], /LOWER\(s\.title\)|LIKE/);
});

test('resolve songs validates request shape and maximum unique ids', async () => {
  const db = createDb([]);
  assert.equal((await handleResolveSongs(makeRequest('{'), db, HEADERS)).status, 400);
  assert.equal((await handleResolveSongs(makeRequest({ song_ids: [] }), db, HEADERS)).status, 400);
  assert.equal((await handleResolveSongs(makeRequest({ song_ids: Array.from({ length: 501 }, (_, i) => `s${i}`) }), db, HEADERS)).status, 400);
});

test('resolve songs chunks large lookups while keeping global order', async () => {
  const songs = Array.from({ length: 105 }, (_, index) => ({
    id: `s${index}`,
    title: `Song ${index}`,
    audio_url: `/s${index}.mp3`,
  }));
  const response = await handleResolveSongs(
    makeRequest({ song_ids: songs.map((song) => song.id).reverse() }),
    createDb(songs),
    HEADERS,
  );
  const payload = await response.json();
  assert.deepEqual(payload.data.songs.map((song) => song.id), songs.map((song) => song.id).reverse());
});

test('search songs returns matches for a keyword and an empty list when the query is blank', async () => {
  const db = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ id: 'one', title: 'One', artist: 'A', audio_url: '/one.mp3' }] }) }) }),
  };

  const hit = await handleSearchSongs(new URL('https://example.test/api/songs/search?q=one'), db, HEADERS);
  const hitPayload = await hit.json();
  assert.equal(hit.status, 200);
  assert.deepEqual(hitPayload.data.songs.map((song) => song.id), ['one']);
  assert.equal(hitPayload.data.query, 'one');
  assert.equal(hit.headers.get('Cache-Control'), 'private, no-store');

  const blank = await handleSearchSongs(new URL('https://example.test/api/songs/search'), db, HEADERS);
  const blankPayload = await blank.json();
  assert.equal(blank.status, 200);
  assert.deepEqual(blankPayload.data.songs, []);

  const retiredAlias = await handleSearchSongs(new URL('https://example.test/api/songs/search?query=one'), db, HEADERS);
  const retiredAliasPayload = await retiredAlias.json();
  assert.deepEqual(retiredAliasPayload.data, { songs: [], query: '' });
});

test('search songs reports a 500 when the database query throws', async () => {
  const db = {
    prepare: () => ({ bind: () => ({ all: async () => { throw new Error('db down'); } }) }),
  };
  const response = await handleSearchSongs(new URL('https://example.test/api/songs/search?q=boom'), db, HEADERS);
  assert.equal(response.status, 500);
});

test('search songs paginates by offset', async () => {
  const pool = Array.from({ length: 45 }, (_, index) => ({
    id: `s${index}`,
    title: `Song ${index}`,
    artist: 'A',
    audio_url: `/s${index}.mp3`,
  }));
  // querySongs binds LIMIT then OFFSET as the last two args.
  const db = {
    prepare: (sql) => {
      const bound = [];
      return {
        bind: (...args) => {
          bound.push(...args);
          return {
            all: async () => {
              if (sql.includes('SELECT 1 AS found')) return { results: [{ found: 1 }] };
              const offset = bound.at(-1);
              const limit = bound.at(-2);
              return { results: pool.slice(offset, offset + limit) };
            },
          };
        },
      };
    },
  };
  const page2 = await handleSearchSongs(new URL('https://example.test/api/songs/search?q=x&limit=20&offset=20'), db, HEADERS);
  const page2Payload = await page2.json();
  assert.equal(page2.status, 200);
  assert.deepEqual(page2Payload.data.songs[0].id, 's20');
  assert.equal(page2Payload.data.songs.length, 20);

  const page3 = await handleSearchSongs(new URL('https://example.test/api/songs/search?q=x&limit=20&offset=40'), db, HEADERS);
  const page3Payload = await page3.json();
  assert.deepEqual(page3Payload.data.songs.map((song) => song.id), ['s40', 's41', 's42', 's43', 's44']);
});

test('search songs validates and applies language before pagination', async () => {
  let capturedDirectPage;
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          if (sql.includes('LIKE ?') && sql.includes('ORDER BY')) capturedDirectPage = { sql, args };
          return { all: async () => ({ results: sql.includes('SELECT 1 AS found') ? [{ found: 1 }] : [] }) };
        },
      };
    },
  };
  const response = await handleSearchSongs(new URL('https://example.test/api/songs/search?q=night&language=ja&limit=20&offset=40'), db, HEADERS);
  assert.equal(response.status, 200);
  assert.match(capturedDirectPage.sql, /AND s\.language = \?[\s\S]*LIMIT \? OFFSET \?/);
  assert.equal(capturedDirectPage.args[0], 'ja');
  assert.deepEqual(capturedDirectPage.args.slice(-2), [20, 40]);

  const invalid = await handleSearchSongs(new URL('https://example.test/api/songs/search?q=night&language=foreign'), db, HEADERS);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).message, 'invalid_language');
});

test('other language search groups every supported non-primary language', async () => {
  let captured;
  const db = { prepare: (sql) => ({ bind: (...args) => ({ all: async () => { captured = { sql, args }; return { results: sql.includes('SELECT 1 AS found') ? [{ found: 1 }] : [] }; } }) }) };
  const response = await handleSearchSongs(new URL('https://example.test/api/songs/search?q=x&language=other'), db, HEADERS);
  assert.equal(response.status, 200);
  assert.match(captured.sql, /s\.language IN \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/);
  assert.deepEqual(captured.args.slice(0, EXTENDED_SONG_LANGUAGES.length), EXTENDED_SONG_LANGUAGES);
});

test('random songs binds LIMIT 10 while filtering unplayable rows', async () => {
  let sql;
  const db = {
    prepare(query) {
      sql = query;
      return {
        bind(limit) {
          assert.equal(limit, 10);
          return { all: async () => ({ results: [{ id: 'a', title: 'A', audio_url: '/a.mp3', language: 'ja' }] }) };
        },
      };
    },
  };
  const response = await handleRandomSongs(new URL('https://example.test/api/songs/random'), db, HEADERS);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.match(sql, /s\.audio_url IS NOT NULL AND s\.audio_url != ''/);
  assert.match(sql, /s\.language/);
  assert.match(sql, /ORDER BY RANDOM\(\)/);
  assert.match(sql, /LIMIT \?/);
  assert.deepEqual(payload.data.songs, [{ id: 'a', title: 'A', audio_url: '/a.mp3', language: 'ja' }]);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});

test('random songs returns the available songs when the library has fewer than 10', async () => {
  const db = {
    prepare: () => ({
      bind: () => ({ all: async () => ({ results: [{ id: 'only' }] }) }),
    }),
  };
  const response = await handleRandomSongs(new URL('https://example.test/api/songs/random'), db, HEADERS);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.data.songs, [{ id: 'only' }]);
});

test('random songs reports a 500 when the database query throws', async () => {
  const db = {
    prepare: () => ({ bind: () => ({ all: async () => { throw new Error('db down'); } }) }),
  };
  const response = await handleRandomSongs(new URL('https://example.test/api/songs/random'), db, HEADERS);
  assert.equal(response.status, 500);
});

test('random songs accepts custom limit query param', async () => {
  let boundLimit;
  const db = {
    prepare() {
      return {
        bind(limit) {
          boundLimit = limit;
          return { all: async () => ({ results: [] }) };
        },
      };
    },
  };
  const response = await handleRandomSongs(new URL('https://example.test/api/songs/random?limit=20'), db, HEADERS);
  assert.equal(response.status, 200);
  assert.equal(boundLimit, 20);
});

const createRandomSongsSqliteFixture = (songCount) => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT, album TEXT, duration INTEGER, audio_url TEXT, cover_url TEXT,
      language TEXT DEFAULT 'other'
    );
  `);
  const insert = sqlite.prepare('INSERT INTO Songs (id, title, audio_url) VALUES (?, ?, ?)');
  for (let index = 0; index < songCount; index += 1) {
    insert.run(`song-${index}`, `Song ${index}`, `/song-${index}.mp3`);
  }

  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async all() {
              return { results: sqlite.prepare(sql).all(...values) };
            },
          };
        },
      };
    },
  };
  return { sqlite, db };
};

test('random songs prioritizes fresh candidates with normalized bound exclusions', async () => {
  let sql;
  let bindings;
  const longId = 'x'.repeat(100);
  const url = new URL(`https://example.test/api/songs/random?exclude=a,,a,%20b%20,${longId},c,d,e,f,g,h,i,j,k`);
  const db = {
    prepare(query) {
      sql = query;
      return {
        bind(...values) {
          bindings = values;
          return { all: async () => ({ results: [] }) };
        },
      };
    },
  };

  const response = await handleRandomSongs(url, db, HEADERS);
  assert.equal(response.status, 200);
  assert.match(sql, /ORDER BY CASE WHEN s\.id IN \(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?\) THEN 1 ELSE 0 END, RANDOM\(\)/);
  assert.deepEqual(bindings, ['a', 'b', 'x'.repeat(80), 'c', 'd', 'e', 'f', 'g', 'h', 'i', 10]);
  assert.doesNotMatch(sql, /\ba\b|\bb\b|x{20}/);
});

test('random songs returns ten entirely fresh songs when ten alternatives exist', async () => {
  const { sqlite, db } = createRandomSongsSqliteFixture(20);
  const excludedIds = Array.from({ length: 10 }, (_, index) => `song-${index}`);
  try {
    const url = new URL(`https://example.test/api/songs/random?exclude=${excludedIds.join(',')}`);
    const response = await handleRandomSongs(url, db, HEADERS);
    const payload = await response.json();
    const resultIds = payload.data.songs.map((song) => song.id);

    assert.equal(response.status, 200);
    assert.equal(resultIds.length, 10);
    assert.equal(resultIds.filter((id) => excludedIds.includes(id)).length, 0);
  } finally {
    sqlite.close();
  }
});

test('random songs fills only the minimum excluded songs when alternatives are insufficient', async () => {
  const { sqlite, db } = createRandomSongsSqliteFixture(14);
  const excludedIds = Array.from({ length: 10 }, (_, index) => `song-${index}`);
  try {
    const url = new URL(`https://example.test/api/songs/random?exclude=${excludedIds.join(',')}`);
    const response = await handleRandomSongs(url, db, HEADERS);
    const payload = await response.json();
    const resultIds = payload.data.songs.map((song) => song.id);
    const repeatedIds = resultIds.filter((id) => excludedIds.includes(id));

    assert.equal(response.status, 200);
    assert.equal(resultIds.length, 10);
    assert.equal(repeatedIds.length, 6);
    assert.equal(resultIds.filter((id) => !excludedIds.includes(id)).length, 4);
  } finally {
    sqlite.close();
  }
});

test('random roam normalizes and bounds the browser seen-id history', () => {
  assert.equal(normalizeRandomRoamSeenIds(null), null);
  assert.deepEqual(
    normalizeRandomRoamSeenIds([' a ', 'a', '', 2, 'x'.repeat(81), 'b']),
    ['a', 'b'],
  );
  assert.equal(
    normalizeRandomRoamSeenIds(Array.from({ length: 5010 }, (_, index) => `song-${index}`)).length,
    5000,
  );
});

test('random roam returns only unseen playable songs and the exact playable total', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, album TEXT,
      duration INTEGER, audio_url TEXT, cover_url TEXT, language TEXT DEFAULT 'other'
    );
  `);
  const insert = sqlite.prepare('INSERT INTO Songs (id, title, audio_url) VALUES (?, ?, ?)');
  for (let index = 0; index < 15; index += 1) {
    insert.run(`song-${index}`, `Song ${index}`, `/song-${index}.mp3`);
  }
  insert.run('silent', 'Silent', '');
  insert.run('blank', 'Blank', '   ');
  const db = {
    prepare(sql) {
      return { all: async () => ({ results: sqlite.prepare(sql).all() }) };
    },
  };
  const request = new Request('https://example.test/api/songs/roam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seenSongIds: Array.from({ length: 10 }, (_, index) => `song-${index}`) }),
  });

  try {
    const response = await handleRandomRoam(request, db, HEADERS);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.totalPlayable, 15);
    assert.equal(payload.data.seenPlayable, 10);
    assert.equal(payload.data.remainingPlayable, 0);
    assert.equal(payload.data.exhausted, true);
    assert.equal(payload.data.songs.length, 5);
    assert.equal(payload.data.songs.some((song) => Number(song.id.slice(5)) < 10), false);
    assert.equal(payload.data.songs.some((song) => song.id === 'silent'), false);
    assert.equal(payload.data.songs.some((song) => song.id === 'blank'), false);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  } finally {
    sqlite.close();
  }
});

test('random roam exhaustion ignores unknown or no-longer-playable seen ids', async () => {
  const db = {
    prepare: () => ({ all: async () => ({ results: [
      { id: 'one', audio_url: '/one.mp3' },
      { id: 'two', audio_url: '/two.mp3' },
      { id: 'three', audio_url: '/three.mp3' },
    ] }) }),
  };
  const response = await handleRandomRoam(new Request('https://example.test/api/songs/roam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seenSongIds: ['deleted-a', 'deleted-b', 'one'] }),
  }), db, HEADERS);
  const payload = await response.json();
  assert.equal(payload.data.totalPlayable, 3);
  assert.equal(payload.data.seenPlayable, 1);
  assert.deepEqual(payload.data.songs.map((song) => song.id), ['two', 'three']);
  assert.equal(payload.data.remainingPlayable, 0);
  assert.equal(payload.data.exhausted, true);
});

test('random roam rejects malformed request bodies and reports database failures', async () => {
  const malformed = await handleRandomRoam(
    new Request('https://example.test/api/songs/roam', { method: 'POST', body: '{' }),
    {},
    HEADERS,
  );
  assert.equal(malformed.status, 400);

  const wrongShape = await handleRandomRoam(
    new Request('https://example.test/api/songs/roam', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seenSongIds: 'song-1' }),
    }),
    {},
    HEADERS,
  );
  assert.equal(wrongShape.status, 400);

  const failed = await handleRandomRoam(
    new Request('https://example.test/api/songs/roam', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seenSongIds: [] }),
    }),
    { prepare: () => ({ all: async () => { throw new Error('db down'); } }) },
    HEADERS,
  );
  assert.equal(failed.status, 500);
});

test('random roam parses custom limit and batchSize with defaults and bounds', async () => {
  assert.equal(parseRoamBatchLimit(undefined), 10);
  assert.equal(parseRoamBatchLimit(null), 10);
  assert.equal(parseRoamBatchLimit(''), 10);
  assert.equal(parseRoamBatchLimit(-1), 10);
  assert.equal(parseRoamBatchLimit(0), 10);
  assert.equal(parseRoamBatchLimit('invalid'), 10);
  assert.equal(parseRoamBatchLimit(5), 5);
  assert.equal(parseRoamBatchLimit('20'), 20);
  assert.equal(parseRoamBatchLimit(100), 50);

  const songs = Array.from({ length: 20 }, (_, index) => ({ id: `song-${index}`, audio_url: `/song-${index}.mp3` }));
  const db = {
    prepare: () => ({ all: async () => ({ results: songs }) }),
  };

  // 1. 缺省默认 10 首
  const defaultRes = await handleRandomRoam(new Request('https://example.test/api/songs/roam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seenSongIds: [] }),
  }), db, HEADERS);
  const defaultPayload = await defaultRes.json();
  assert.equal(defaultPayload.data.limit, 10);
  assert.equal(defaultPayload.data.songs.length, 10);
  assert.equal(defaultPayload.data.remainingPlayable, 10);

  // 2. 自定义 limit: 5
  const limit5Res = await handleRandomRoam(new Request('https://example.test/api/songs/roam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seenSongIds: [], limit: 5 }),
  }), db, HEADERS);
  const limit5Payload = await limit5Res.json();
  assert.equal(limit5Payload.data.limit, 5);
  assert.equal(limit5Payload.data.songs.length, 5);
  assert.equal(limit5Payload.data.remainingPlayable, 15);

  // 3. 支持 batchSize 别名
  const batchRes = await handleRandomRoam(new Request('https://example.test/api/songs/roam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seenSongIds: [], batchSize: 15 }),
  }), db, HEADERS);
  const batchPayload = await batchRes.json();
  assert.equal(batchPayload.data.limit, 15);
  assert.equal(batchPayload.data.songs.length, 15);

  // 4. 边界校验：超过 50 截断为 50，小于 1 或非法时回退 10
  const maxRes = await handleRandomRoam(new Request('https://example.test/api/songs/roam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seenSongIds: [], limit: 999 }),
  }), db, HEADERS);
  assert.equal((await maxRes.json()).data.limit, 50);

  const fallbackRes = await handleRandomRoam(new Request('https://example.test/api/songs/roam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seenSongIds: [], limit: -3 }),
  }), db, HEADERS);
  assert.equal((await fallbackRes.json()).data.limit, 10);
});

test('handleGetSongsByLanguage validates language code and returns paginated songs with sorting', async () => {
  const invalid = await handleGetSongsByLanguage(
    new URL('https://example.test/api/songs?language=invalid_lang'),
    {},
    HEADERS,
  );
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.message, 'invalid_language');

  let countCalled = false;
  let listCalled = false;
  const fakeDb = {
    prepare(sql) {
      if (sql.includes('COUNT(*)')) {
        return {
          bind(lang) {
            assert.equal(lang, 'ja');
            countCalled = true;
            return {
              async all() {
                return { results: [{ total: 45 }] };
              },
            };
          },
        };
      }
      assert.match(sql, /s\.language = \?/);
      assert.match(sql, /ORDER BY CASE WHEN s\.created_at IS NOT NULL/);
      assert.match(sql, /LIMIT \? OFFSET \?/);
      return {
        bind(lang, limit, offset) {
          assert.equal(lang, 'ja');
          assert.equal(limit, 30);
          assert.equal(offset, 0);
          listCalled = true;
          return {
            async all() {
              return { results: [{ id: 'ja-1', title: 'Japanese Song', language: 'ja', audio_url: '/ja.mp3' }] };
            },
          };
        },
      };
    },
  };

  const url = new URL('https://example.test/api/songs?language=ja&page=1&limit=30&sort=desc');
  const response = await handleGetSongsByLanguage(url, fakeDb, HEADERS);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, 200);
  assert.equal(body.data.language, 'ja');
  assert.equal(body.data.total, 45);
  assert.equal(body.data.page, 1);
  assert.equal(body.data.pageSize, 30);
  assert.equal(body.data.hasMore, true);
  assert.equal(body.data.sort, 'desc');
  assert.equal(body.data.songs[0].id, 'ja-1');
  assert.equal(countCalled, true);
  assert.equal(listCalled, true);
});

test('handleRandomRoam supports filtering by language', async () => {
  let boundLanguage = null;
  const fakeDb = {
    prepare(sql) {
      assert.match(sql, /s\.language = \?/);
      return {
        bind(lang) {
          boundLanguage = lang;
          return {
            async all() {
              return {
                results: [
                  { id: 'zh-1', language: 'zh', audio_url: '/zh1.mp3' },
                  { id: 'zh-2', language: 'zh', audio_url: '/zh2.mp3' },
                ],
              };
            },
          };
        },
      };
    },
  };

  const req = new Request('https://example.test/api/songs/roam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seenSongIds: ['zh-1'], language: 'zh' }),
  });

  const res = await handleRandomRoam(req, fakeDb, HEADERS);
  assert.equal(res.status, 200);
  const data = (await res.json()).data;
  assert.equal(boundLanguage, 'zh');
  assert.equal(data.language, 'zh');
  assert.equal(data.totalPlayable, 2);
  assert.equal(data.seenPlayable, 1);
  assert.equal(data.remainingPlayable, 0);
  assert.equal(data.exhausted, true);
  assert.deepEqual(data.songs.map((s) => s.id), ['zh-2']);
});

test('handleRandomRoam rejects invalid language code', async () => {
  const req = new Request('https://example.test/api/songs/roam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seenSongIds: [], language: 'alien-lang' }),
  });
  const res = await handleRandomRoam(req, {}, HEADERS);
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.message, 'invalid_language');
});

test('handleGetSongLanguageCounts returns mapped counts', async () => {
  const fakeDb = {
    prepare(sql) {
      assert.match(sql, /GROUP BY s\.language/);
      return {
        async all() {
          return {
            results: [
              { language: 'zh', count: 234 },
              { language: 'en', count: 529 },
              { language: 'ja', count: 70 },
            ],
          };
        },
      };
    },
  };

  const response = await handleGetSongLanguageCounts(fakeDb, HEADERS);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, 200);
  assert.deepEqual(body.data, { zh: 234, en: 529, ja: 70 });
});

test('parseSpotlightExcludeArtists correctly trims, limits, and deduplicates', () => {
  const url = new URL('https://example.test/api/songs/spotlight-artist?exclude=周杰伦,林俊杰, 周杰伦 , Taylor Swift');
  const list = parseSpotlightExcludeArtists(url);
  assert.deepEqual(list, ['周杰伦', '林俊杰', 'Taylor Swift']);
});

test('handleSpotlightArtist returns selected artist, songs, and photo with fallback when excluded', async () => {
  const queries = [];
  const fakeDb = {
    prepare(sql) {
      queries.push(sql);
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('FROM Artist_Photos')) {
                return { photo_url: 'https://cdn.test/jay.jpg', photos: '[]' };
              }
              if (sql.includes('s.artist NOT IN')) {
                // exclude test
                return null;
              }
              return { artist: '周杰伦', song_count: 5 };
            },
            async all() {
              return {
                results: [
                  { id: '101', title: '晴天', artist: '周杰伦', cover_url: '/covers/101.jpg', audio_url: '/audio/101.mp3' },
                  { id: '102', title: '七里香', artist: '周杰伦', cover_url: '/covers/102.jpg', audio_url: '/audio/102.mp3' },
                ],
              };
            },
          };
        },
        async first() {
          return { artist: '周杰伦', song_count: 5 };
        },
      };
    },
  };

  const url = new URL('https://example.test/api/songs/spotlight-artist?exclude=林俊杰');
  const res = await handleSpotlightArtist(url, fakeDb, HEADERS, { subject: 'user-1' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.code, 200);
  assert.equal(body.data.artist, '周杰伦');
  assert.equal(body.data.songCount, 5);
  assert.equal(body.data.songs.length, 2);
  assert.equal(body.data.photoUrl, 'https://cdn.test/jay.jpg');
  assert.equal(body.data.coverUrl, '/covers/101.jpg');
});
