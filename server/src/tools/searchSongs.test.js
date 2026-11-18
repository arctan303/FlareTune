import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { querySongs, querySongPage } from './searchSongs.js';

function createD1Adapter(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async all() {
              return { results: sqlite.prepare(sql).all(...bindings) };
            },
          };
        },
      };
    },
  };
}

// D1 caps LIKE/GLOB patterns at 50 UTF-8 bytes. Keep SQLite's own LIKE
// matching semantics while imposing that production limit in these cases.
function createPatternLimitedD1(sqlite, context) {
  const reference = new DatabaseSync(':memory:');
  context.after(() => reference.close());
  sqlite.function('like', { varargs: true }, (pattern, value, escape) => {
    if (pattern != null && Buffer.byteLength(pattern, 'utf8') > 50) {
      throw new Error('LIKE pattern exceeds D1 limit');
    }
    return escape === undefined
      ? reference.prepare('SELECT ? LIKE ? AS matched').get(value, pattern).matched
      : reference.prepare('SELECT ? LIKE ? ESCAPE ? AS matched').get(value, pattern, escape).matched;
  });
  return createD1Adapter(sqlite);
}

function searchCatalog(context) {
  const sqlite = new DatabaseSync(':memory:');
  context.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE Songs(id TEXT PRIMARY KEY,title TEXT NOT NULL,artist TEXT,album TEXT,
    duration INTEGER,audio_url TEXT,cover_url TEXT,language TEXT)`);
  return { sqlite, db: createPatternLimitedD1(sqlite, context),
    insert: sqlite.prepare('INSERT INTO Songs(id,title,artist,album,audio_url,language) VALUES(?,?,?,?,?,?)') };
}

test('long song searches preserve complete literal and compact matches across all metadata fields', async (t) => {
  const { db, insert } = searchCatalog(t);
  const query = 'Come Into My World (Extended Version) - Alexandra Stan / NERVO';
  for (const [index, field] of ['title', 'artist', 'album'].entries()) {
    for (const compact of [false, true]) {
      const values = { title: 'Other title', artist: 'Other artist', album: 'Other album',
        [field]: compact ? query.replaceAll(' ', '\t') : query };
      insert.run(`${index}-${compact}`, values.title, values.artist, values.album, '/audio', 'en');
    }
  }
  insert.run('truncated-decoy', query.slice(0, 48) + ' Different ending', '', '', '/decoy', 'en');
  insert.run('unplayable', query, '', '', null, 'en');
  const page = await querySongPage(db, query, 20);
  assert.deepEqual(page.songs.map(song => song.id).sort(),
    ['0-false', '0-true', '1-false', '1-true', '2-false', '2-true']);
  assert.equal(page.hasMore, false);
});

test('song substring searches handle the D1 byte boundary, multibyte text and literal pattern characters', async (t) => {
  const queries = ['a'.repeat(48), 'a'.repeat(49),
    '非常に長い日本語の曲名が繰り返されるライブ録音', '50%_\\literal'.repeat(4), '100%_\\live'];
  for (const query of queries) {
    await t.test(JSON.stringify(query), async (context) => {
      const { db, insert } = searchCatalog(context);
      insert.run('exact', `Prefix ${query} Suffix`, '', '', '/exact', 'ja');
      insert.run('different', `Prefix ${query.slice(0, -1)}X Suffix`, '', '', '/different', 'ja');
      insert.run('wildcard-decoy', '100ZZZlive', '', '', '/wildcard', 'ja');
      const result = await querySongPage(db, query, 20);
      assert.deepEqual(result.songs.map(song => song.id), ['exact']);
    });
  }
});

test('long search candidates retain exact-page exhaustion and cleaned fallback ordering', async (t) => {
  const { db, insert } = searchCatalog(t);
  const query = 'Come Into My World (Extended Version) - Alexandra Stan / NERVO';
  insert.run('exact-1', query, 'Artist A', '', '/1', 'en');
  insert.run('exact-2', query, 'Artist B', '', '/2', 'en');
  insert.run('broad-1', 'Come Into My World', 'Artist C', '', '/3', 'en');
  assert.deepEqual((await querySongPage(db, query, 1, 0)).songs.map(song => song.id), ['exact-1']);
  const final = await querySongPage(db, query, 1, 1);
  assert.deepEqual(final.songs.map(song => song.id), ['exact-2']);
  assert.equal(final.hasMore, false);
  assert.deepEqual(await querySongPage(db, query, 1, 2), { songs: [], hasMore: false });

  const absentVersion = 'Come Into My World (A Different Extended Version) - Alexandra Stan / NERVO';
  const fallback = await querySongPage(db, absentVersion, 2, 0);
  assert.deepEqual(fallback.songs.map(song => song.id), ['broad-1', 'exact-1']);
  assert.equal(fallback.hasMore, true);
  assert.deepEqual((await querySongPage(db, absentVersion, 2, 2)).songs.map(song => song.id), ['exact-2']);
});

test('language search uses stable ordering across real SQLite pages', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      duration INTEGER,
      audio_url TEXT,
      cover_url TEXT,
      language TEXT
    );
    INSERT INTO Songs (id, title, artist, album, duration, audio_url, language) VALUES
      ('ja-3', 'Track C', 'Artist', '', 1, '/3.mp3', 'ja'),
      ('ja-1', 'Track A', 'Artist', '', 1, '/1.mp3', 'ja'),
      ('ja-4', 'Track D', 'Artist', '', 1, '/4.mp3', 'ja'),
      ('ja-2', 'Track B', 'Artist', '', 1, '/2.mp3', 'ja'),
      ('en-1', 'Track English', 'Artist', '', 1, '/en.mp3', 'en');
  `);
  try {
    const db = createD1Adapter(sqlite);
    const options = { user: { subject: 'member' }, language: 'ja' };
    const first = await querySongs(db, 'track', 2, 0, options);
    const second = await querySongs(db, 'track', 2, 2, options);
    assert.deepEqual(first.map((song) => song.id), ['ja-1', 'ja-2']);
    assert.deepEqual(second.map((song) => song.id), ['ja-3', 'ja-4']);
    assert.equal(new Set([...first, ...second].map((song) => song.id)).size, 4);
  } finally {
    sqlite.close();
  }
});

test('other language search excludes unknown database values', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      duration INTEGER,
      audio_url TEXT,
      cover_url TEXT,
      language TEXT
    );
    INSERT INTO Songs (id, title, artist, audio_url, language) VALUES
      ('fr-1', 'Track French', 'Artist', '/fr.mp3', 'fr'),
      ('other-1', 'Track Other', 'Artist', '/other.mp3', 'other'),
      ('invalid-1', 'Track Invalid', 'Artist', '/invalid.mp3', 'foreign'),
      ('zh-1', 'Track Chinese', 'Artist', '/zh.mp3', 'zh');
  `);
  try {
    const results = await querySongs(createD1Adapter(sqlite), 'track', 10, 0, {
      user: { subject: 'member' },
      language: 'other',
    });
    assert.deepEqual(results.map((song) => song.id), ['fr-1', 'other-1']);
  } finally {
    sqlite.close();
  }
});

test('later pages keep the initially selected query candidate instead of widening', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      duration INTEGER,
      audio_url TEXT,
      cover_url TEXT,
      language TEXT
    );
  `);
  const insert = sqlite.prepare('INSERT INTO Songs (id, title, artist, audio_url, language) VALUES (?, ?, ?, ?, ?)');
  for (let index = 0; index < 20; index += 1) {
    insert.run(`remix-${index}`, `Track - Remix ${String(index).padStart(2, '0')}`, 'Artist', `/remix-${index}.mp3`, 'en');
  }
  for (let index = 0; index < 15; index += 1) {
    insert.run(`broad-${index}`, `Track Generic ${String(index).padStart(2, '0')}`, 'Artist', `/broad-${index}.mp3`, 'en');
  }
  try {
    const db = createD1Adapter(sqlite);
    const options = { user: { subject: 'member' }, language: 'en' };
    const first = await querySongs(db, 'Track - Remix', 20, 0, options);
    const second = await querySongs(db, 'Track - Remix', 20, 20, options);
    assert.equal(first.length, 20);
    assert.deepEqual(second, []);
    assert.ok(first.every((song) => song.id.startsWith('remix-')));
  } finally {
    sqlite.close();
  }
});

test('Japanese kana titles match romaji with stable pagination and language filtering', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
      duration INTEGER, audio_url TEXT, cover_url TEXT, language TEXT);
    INSERT INTO Songs (id, title, artist, audio_url, language) VALUES
      ('ja-1', 'はいよろこんで', 'こっちのけんと', '/1.mp3', 'ja'),
      ('ja-2', 'ハイヨロコンデ', '別の歌手', '/2.mp3', 'ja'),
      ('en-1', 'haiyorokonde', 'Other', '/3.mp3', 'en'),
      ('ja-unplayable', 'はいよろこんで', 'Other', NULL, 'ja');
  `);
  try {
    const db = createD1Adapter(sqlite);
    const options = { language: 'ja' };
    assert.deepEqual((await querySongs(db, 'haiyorokonde', 1, 0, options)).map((song) => song.id), ['ja-1']);
    assert.deepEqual((await querySongs(db, 'haiyorokonde', 1, 1, options)).map((song) => song.id), ['ja-2']);
    assert.deepEqual((await querySongs(db, 'haiyorokonde', 1, 2, options)), []);
    assert.deepEqual((await querySongs(db, 'haiyorokonde', 10)).map((song) => song.id),
      ['en-1', 'ja-1', 'ja-2']);
  } finally { sqlite.close(); }
});

test('romanized keyset pages preserve NULL/empty artists and do not repeat candidate OFFSET scans', async () => {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE Songs(id TEXT PRIMARY KEY,title TEXT,artist TEXT,album TEXT,duration INTEGER,audio_url TEXT,cover_url TEXT,language TEXT)`);
  const insert=sqlite.prepare('INSERT INTO Songs(id,title,artist,audio_url,language) VALUES (?,?,?,?,?)');
  for(let i=0;i<2500;i++)insert.run(String(i).padStart(5,'0'),'はいよろこんで',i%2?null:'','/audio','ja');
  try{
    const expected=sqlite.prepare('SELECT id FROM Songs ORDER BY LOWER(title),LOWER(artist),id LIMIT 3 OFFSET 1100').all().map(r=>r.id);
    const queries=[];const adapter=createD1Adapter(sqlite);
    const db={prepare(sql){queries.push(sql);return adapter.prepare(sql);}};
    const result=await querySongs(db,'haiyorokonde',3,1100);
    assert.deepEqual(result.map(r=>r.id),expected);
    assert.equal(queries.filter(sql=>sql.includes('GLOB')).length,2);
    assert.ok(queries.filter(sql=>sql.includes('GLOB')).every(sql=>!sql.includes('OFFSET')));
    assert.ok(result.every(row=>Object.keys(row).every(key=>!key.startsWith('search_key_'))));
  }finally{sqlite.close();}
});

test('exhausted romanized pages retain the chosen candidate and partial direct hits never duplicate', async () => {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE Songs(id TEXT PRIMARY KEY,title TEXT,artist TEXT,album TEXT,duration INTEGER,audio_url TEXT,cover_url TEXT,language TEXT);
    INSERT INTO Songs(id,title,artist,audio_url,language) VALUES
    ('specific','はいよろこんで remix',NULL,'/a','ja'),('broad','はいよろこんで',NULL,'/b','ja');`);
  try{
    const db=createD1Adapter(sqlite);
    assert.deepEqual((await querySongs(db,'haiyorokonde - remix',1)).map(r=>r.id),['specific']);
    assert.deepEqual(await querySongs(db,'haiyorokonde - remix',1,1),[]);
    sqlite.exec("INSERT INTO Songs(id,title,artist,audio_url,language) VALUES ('both','haiyorokonde はいよろこんで',NULL,'/c','ja')");
    assert.deepEqual((await querySongs(db,'haiyorokonde',10)).map(r=>r.id),['both','broad','specific']);
    assert.deepEqual((await querySongs(db,'haiyorokonde',2,1)).map(r=>r.id),['broad','specific']);
  }finally{sqlite.close();}
});

test('look-ahead pagination preserves direct/romanized ordering and detects an exactly full final page', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE Songs(id TEXT PRIMARY KEY,title TEXT,artist TEXT,album TEXT,duration INTEGER,audio_url TEXT,cover_url TEXT,language TEXT);
    INSERT INTO Songs(id,title,artist,audio_url,language) VALUES
    ('direct','haiyorokonde はいよろこんで',NULL,'/direct','ja'),
    ('kana-a','はいよろこんで','A','/kana-a','ja'),
    ('kana-b','ハイヨロコンデ','B','/kana-b','ja');`);
  try {
    const db = createD1Adapter(sqlite);
    const first = await querySongPage(db, 'haiyorokonde', 2, 0, { language: 'ja' });
    assert.deepEqual(first.songs.map(song => song.id), ['direct', 'kana-a']);
    assert.equal(first.hasMore, true);
    const final = await querySongPage(db, 'haiyorokonde', 2, 1, { language: 'ja' });
    assert.deepEqual(final.songs.map(song => song.id), ['kana-a', 'kana-b']);
    assert.equal(final.hasMore, false);
    assert.deepEqual(await querySongPage(db, 'haiyorokonde', 2, 3), { songs: [], hasMore: false });
  } finally { sqlite.close(); }
});
