import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleLocalAlbumReadRoute } from './localAlbumRead.js';

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async first() { return this.db.prepare(this.sql).get(...this.params) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
}

function catalog() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
  sqlite.exec(`INSERT INTO Songs(id,title,artist,album,audio_url,cover_url,language,created_at) VALUES
    ('a1','First','A / B','Shared','/media/a1','/media/shared','zh',1),
    ('a2','Second','A / B','Shared','/media/a2','/media/other','en',2),
    ('a3','Third','A','Solo','/media/a3','/media/solo','zh',3),
    ('b1','Fourth','B','Solo','/media/b1','/media/b','en',4),
    ('ghost','No audio','A','Shared',NULL,'/media/ghost','zh',5),
    ('blank','No album','A',NULL,'/media/blank',NULL,'zh',6);`);
  return { sqlite, prepare(sql) { return new Statement(sqlite, sql); } };
}

async function call(db, path, accountId = 'member') {
  const request = new Request(`https://flaretune.test${path}`);
  const response = await handleLocalAlbumReadRoute(request, new URL(request.url), db, {}, accountId);
  return { response, body: response && await response.json() };
}

test('album browse, artist membership and detail use full local playable tracks', async () => {
  const db = catalog();
  const listing = (await call(db, '/api/albums?limit=2')).body.data;
  assert.equal(listing.total, 3);
  assert.equal(listing.hasMore, true);
  assert.equal(listing.albums[0].title, 'Shared');
  assert.equal(listing.albums[0].trackCount, 2);
  const next = (await call(db, '/api/albums?limit=2&offset=2')).body.data;
  assert.equal(next.albums.length, 1);
  const artistA = (await call(db, '/api/albums?artist=A')).body.data;
  assert.deepEqual(artistA.albums.map((item) => item.title).sort(), ['Shared', 'Solo']);
  const artistB = (await call(db, '/api/albums?artist=B')).body.data;
  assert.equal(artistB.total, 2);
  assert.equal((await call(db, '/api/albums?artist=Sh')).body.data.total, 0);
  const language = (await call(db, '/api/albums?language=zh')).body.data;
  assert.equal(language.total, 2);
  assert.equal(language.albums.find((item) => item.title === 'Shared').trackCount, 2);
  assert.equal(language.albums.find((item) => item.title === 'Shared').matchingTrackCount, 1);
  assert.equal((await call(db, '/api/albums?language=en')).body.data.albums
    .find((item) => item.title === 'Shared').coverUrl, '/media/shared');
  const detail = (await call(db, `/api/albums/${listing.albums[0].id}`)).body.data;
  assert.deepEqual(detail.songs.map((song) => song.id), ['a1', 'a2']);
  assert.equal(detail.trackCount, 2);
  assert.equal(detail.artist, 'A / B');
});

test('artist cards and paginated detail support exploration without song search truncation', async () => {
  const db = catalog();
  db.sqlite.exec(`INSERT INTO Artist_Photos(artist_name,photo_url,created_at,updated_at)
    VALUES ('A','/media/portrait',1,1)`);
  const artists = (await call(db, '/api/artists?language=zh')).body.data;
  assert.equal(artists.total, 2);
  assert.deepEqual(artists.artists.map((item) => item.name).sort(), ['A', 'B']);
  assert.equal(artists.artists.find((item) => item.name === 'A').photoUrl, '/media/portrait');
  const detail = (await call(db, '/api/artists/A?limit=1&offset=1')).body.data;
  assert.equal(detail.songCount, 4);
  assert.equal(detail.songs.length, 1);
  assert.equal(detail.hasMore, true);
  assert.equal((await call(db, '/api/artists/Absent')).response.status, 404);
});

test('Unicode case variants find artist credits and album titles without SQLite ASCII-only folding', async () => {
  const db = catalog();
  db.sqlite.exec(`INSERT INTO Songs(id,title,artist,album,audio_url,language)
    VALUES ('unicode','Accent','Émile','Été','/media/unicode','fr')`);
  assert.equal((await call(db, '/api/artists?q=%C3%A9mile')).body.data.artists[0].name, 'Émile');
  assert.deepEqual((await call(db, '/api/artists/%C3%A9mile')).body.data.songs.map((song) => song.id), ['unicode']);
  assert.equal((await call(db, '/api/albums?artist=%C3%A9mile')).body.data.albums[0].title, 'Été');
  assert.equal((await call(db, '/api/albums?q=%C3%A9t%C3%A9')).body.data.albums[0].artist, 'Émile');
  assert.equal((await call(db, '/api/albums?q=')).body.data.total, 4);
});

test('album and artist reads reject anonymous and invalid identity or filters', async () => {
  const db = catalog();
  assert.equal((await call(db, '/api/albums', null)).response.status, 401);
  assert.equal((await call(db, '/api/artists', null)).response.status, 401);
  for (const path of ['/api/albums/not-an-id', '/api/albums?limit=0', '/api/albums?language=xx',
    '/api/albums?artist=%00', '/api/artists?offset=-1', '/api/artists/%ZZ']) {
    assert.equal((await call(db, path)).response.status, 400, path);
  }
  assert.equal((await call(db, '/api/albums?artist=Nobody')).body.data.total, 0);
  assert.equal(await handleLocalAlbumReadRoute(new Request('https://flaretune.test/api/songs'),
    new URL('https://flaretune.test/api/songs'), db, {}, 'member'), null);
});

test('album cover ranking preserves playable counts, blank artwork, trimming and stable date ties', async () => {
  const db = catalog();
  db.sqlite.exec(`INSERT INTO Songs(id,title,artist,album,audio_url,cover_url,created_at) VALUES
    ('r0','No artwork',' Rank ',' Edge ','/media/r0','  ',0),
    ('r1','Undated','Rank','Edge','/media/r1','/media/undated',NULL),
    ('r2','Tie first','Rank','Edge','/media/r2','/media/winner',1),
    ('r3','Tie last','Rank','Edge','/media/r3','/media/loser',1),
    ('r4','Unplayable','Rank','Edge',' ','/media/ignored',0),
    ('r5','Blank album cover','Rank','Empty','/media/r5',' ',1),
    ('r6','Null album cover','Rank','Empty','/media/r6',NULL,2)`);
  const albums = (await call(db, '/api/albums?artist=Rank')).body.data.albums;
  const edge = albums.find((album) => album.title === 'Edge');
  assert.equal(edge.trackCount, 4);
  assert.equal(edge.coverUrl, '/media/winner');
  const empty = albums.find((album) => album.title === 'Empty');
  assert.equal(empty.trackCount, 2);
  assert.equal(empty.coverUrl, '');
  db.sqlite.close();
});
