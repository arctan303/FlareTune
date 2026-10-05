import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { querySongs } from './searchSongs.js';

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
