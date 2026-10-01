import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createRoamSampler } from './roam-sampler-prototype.mjs';

function database(count = 1000) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE Songs(id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT, duration INTEGER, audio_url TEXT, cover_url TEXT, language TEXT)');
  const insert = sqlite.prepare('INSERT INTO Songs VALUES(?,?,?,?,?,?,?,?)');
  for (let i = 0; i < count; i++) insert.run(`s${i}`, `Song ${i}`, 'Artist', 'Album', 180, '/audio', '/cover', ['en', 'ja', 'zh', 'yue', 'ru'][i % 5]);
  const queries = [];
  let fail = false;
  const db = { sqlite, queries, failNext() { fail = true; }, prepare(sql) {
    return { bind(...params) { return { async all() {
      queries.push(sql);
      if (fail) { fail = false; throw new Error('injected'); }
      return { results: sqlite.prepare(sql).all(...params) };
    } }; } };
  } };
  return db;
}
function seeded(seed = 12345) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}
test('cold/warm/expired directory and concurrent first reads are bounded and database-scoped', async () => {
  const db = database(); const other = database(3); const sampler = createRoamSampler();
  const results = await Promise.all(Array.from({ length: 20 }, () => sampler.sample(db, { now: 0 })));
  assert.ok(results.every((result) => result.songs.length === 10));
  assert.equal(db.queries.filter((sql) => sql.includes('SELECT id, language')).length, 1);
  assert.equal(db.queries.length, 21);
  db.sqlite.exec("INSERT INTO Songs VALUES('new','New','Artist','Album',180,'/audio','/cover','en')");
  const queued = Array.from({ length: 1000 }, (_, i) => `s${i}`);
  assert.equal((await sampler.sample(db, { now: 3_599_999, queued })).songs.length, 0);
  assert.equal((await sampler.sample(db, { now: 3_600_000, queued })).songs[0].id, 'new');
  assert.equal((await sampler.sample(other, { now: 0 })).songs.length, 3);
  assert.equal(other.queries.length, 2);
});
test('recent 200, queued and buffered IDs are excluded without changing multi-language semantics', async () => {
  const db = database(); const sampler = createRoamSampler();
  const recent = Array.from({ length: 200 }, (_, i) => `s${i}`);
  const queued = ['s203', 's204']; const buffered = ['s208', 's209'];
  const result = await sampler.sample(db, { language: 'other', recent, queued, buffered, limit: 50, random: seeded() });
  const excluded = new Set([...recent, ...queued, ...buffered]);
  assert.equal(result.songs.length, 50);
  assert.equal(new Set(result.songs.map((song) => song.id)).size, 50);
  assert.ok(result.songs.every((song) => ['yue', 'ru'].includes(song.language) && !excluded.has(song.id)));
  const enJa = await sampler.sample(db, { language: 'en,ja', limit: 50 });
  assert.ok(enJa.songs.every((song) => ['en', 'ja'].includes(song.language)));
});
test('small catalog relaxes oldest recent exclusions but never queue or buffer; empty catalog ends', async () => {
  const db = database(12); const sampler = createRoamSampler();
  const result = await sampler.sample(db, { recent: Array.from({ length: 12 }, (_, i) => `s${i}`), queued: ['s0'], buffered: ['s1'], limit: 10 });
  assert.equal(result.songs.length, 10);
  assert.equal(result.relaxed, 10);
  assert.ok(result.songs.every((song) => !['s0', 's1'].includes(song.id)));
  const partial = await sampler.sample(db, { recent: ['s0','s1','s2','s3'], limit: 10 });
  assert.equal(partial.relaxed, 2);
  assert.ok(partial.songs.every((song) => !['s2', 's3'].includes(song.id)));
  assert.equal((await sampler.sample(database(0))).songs.length, 0);
  assert.equal((await sampler.sample(database(1), { queued: ['s0'] })).songs.length, 0);
});
test('stale deletion, unplayable audio and changed language are rechecked and refreshed before return', async () => {
  const db = database(15); const sampler = createRoamSampler();
  await sampler.sample(db, { language: 'en', now: 0 });
  db.sqlite.exec("DELETE FROM Songs WHERE id='s0'; UPDATE Songs SET language='ja' WHERE id='s5'; UPDATE Songs SET audio_url='' WHERE id='s10'; INSERT INTO Songs VALUES('new','New','Artist','Album',180,'/audio','/cover','en')");
  const result = await sampler.sample(db, { language: 'en', now: 1 });
  assert.deepEqual(result.songs.map((song) => song.id), ['new']);
  assert.equal(db.queries.filter((sql) => sql.includes('SELECT id, language')).length, 2);
});
test('failed snapshot can recover and directory cap fails explicitly instead of sampling only a prefix', async () => {
  const db = database(15); const sampler = createRoamSampler();
  db.failNext();
  await assert.rejects(sampler.sample(db), /injected/);
  assert.equal((await sampler.sample(db)).songs.length, 10);
  await assert.rejects(createRoamSampler({ maxIds: 10 }).sample(db), /PROTOTYPE_DIRECTORY_LIMIT/);
});
test('seeded distribution sanity check across 100 candidates: no duplicates or excluded IDs', async () => {
  const db = database(110); const sampler = createRoamSampler(); const random = seeded(9876);
  const counts = new Map(Array.from({ length: 100 }, (_, i) => [`s${i + 10}`, 0]));
  const recent = Array.from({ length: 10 }, (_, i) => `s${i}`);
  for (let n = 0; n < 10000; n++) {
    const result = await sampler.sample(db, { recent, limit: 10, random });
    assert.equal(new Set(result.songs.map((song) => song.id)).size, 10);
    for (const song of result.songs) { assert.ok(counts.has(song.id)); counts.set(song.id, counts.get(song.id) + 1); }
  }
  const frequencies = [...counts.values()];
  const chiSquared = frequencies.reduce((sum, count) => sum + (count - 1000) ** 2 / 1000, 0);
  assert.ok(chiSquared < 160, `distribution regression: chiSquared=${chiSquared}`);
  console.log(JSON.stringify({ distribution: { draws: 100000, candidates: 100, expectedEach: 1000,
    min: Math.min(...frequencies), max: Math.max(...frequencies), chiSquared } }));
});

test('20 percent window adapts to the selected language range without a separate COUNT query', async () => {
  const db = database(1000); const sampler = createRoamSampler();
  const recent = Array.from({ length: 1000 }, (_, i) => `s${i}`);
  const all = await sampler.sample(db, { recent, recentRatio: 0.2 });
  assert.equal(all.windowSize, 200);
  assert.ok(all.songs.every((song) => Number(song.id.slice(1)) < 800));
  const before = db.queries.length;
  const en = await sampler.sample(db, { recent, recentRatio: 0.2, language: 'en' });
  assert.equal(en.rangeSize, 200);
  assert.equal(en.windowSize, 40);
  assert.equal(db.queries.length - before, 1);
  assert.ok(en.songs.every((song) => song.language === 'en' && Number(song.id.slice(1)) < 800));
  const both = await sampler.sample(db, { recent, recentRatio: 0.2, language: 'en,ja' });
  assert.equal(both.rangeSize, 400);
  assert.equal(both.windowSize, 80);
});

test('20 percent across tiny catalogs, high batch size and a long queue stays bounded', async () => {
  for (const size of [0, 1, 3, 5, 10, 20, 50, 100]) {
    const db = database(size); const sampler = createRoamSampler();
    const recent = Array.from({ length: size }, (_, i) => `s${i}`);
    const queued = size ? ['s0'] : [];
    const buffered = size > 1 ? ['s1'] : [];
    const result = await sampler.sample(db, { recent, queued, buffered, recentRatio: 0.2, limit: 10 });
    assert.equal(result.windowSize, Math.floor(size * 0.2));
    assert.equal(result.songs.length, Math.min(10, Math.max(0, size - queued.length - buffered.length)));
    assert.ok(result.songs.every((song) => !queued.includes(song.id) && !buffered.includes(song.id)));
    assert.ok(db.queries.length <= 2);
  }
  const db = database(100); const sampler = createRoamSampler();
  const result = await sampler.sample(db, { recent: Array.from({ length: 100 }, (_, i) => `s${i}`),
    queued: Array.from({ length: 95 }, (_, i) => `s${i}`), recentRatio: 0.2, limit: 50 });
  assert.equal(result.songs.length, 5);
  assert.equal(result.relaxed, 5);
});
