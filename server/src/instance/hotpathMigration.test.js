import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {MIGRATION_BUNDLE} from './migrationBundle.generated.js';
import {HOTPATH_OBJECTS,hasHotpathObjects} from './hotpathSchema.js';

const sql=readFileSync(new URL('../../db/migrations-flaretune/0013_hotpath_indexes_and_counts.sql',import.meta.url),'utf8');
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  for(const step of MIGRATION_BUNDLE.slice(0,12))for(const statement of step.statements)db.exec(statement);
  db.exec(`INSERT INTO accounts(account_id,username,role,created_at,updated_at) VALUES
    ('a','alice','admin',1,1),('b','bob','member',1,1);
    INSERT INTO Songs(id,title,audio_url) VALUES ('s1','One','/one'),('s2','Two','/two'),('s3','Three','/three');
    INSERT INTO Member_Playlists(id,account_id,kind,name,created_at,updated_at) VALUES
    ('p1','a','regular','One',1,1),('p2','a','regular','Two',1,1),('empty','b','regular','Empty',1,1);
    INSERT INTO Member_Playlist_Songs(playlist_id,song_id,sort_order,added_at) VALUES ('p1','s1',0,1),('p1','s2',1,1);
    INSERT INTO Member_Play_Events(account_id,event_id,song_id,played_at,received_at) VALUES ('a','e1','s1',1,1),('a','e2','s2',1,1);`);
  return db;
}
function verify(db){
  assert.deepEqual(db.prepare(`SELECT id FROM Member_Playlists p WHERE cached_song_count !=
    (SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id=p.id)`).all(),[]);
  assert.deepEqual(db.prepare(`SELECT account_id FROM Member_Play_Receipt_Counts c WHERE receipt_count !=
    (SELECT COUNT(*) FROM Member_Play_Events WHERE account_id=c.account_id)`).all(),[]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
}
test('hotpath migration backfills and keeps counts correct through supported writes and cascades',()=>{
  const db=fixture();try{
    db.exec('UPDATE Member_Playlists SET cached_song_count=0');db.exec(sql);verify(db);
    assert.equal(db.prepare("SELECT receipt_count n FROM Member_Play_Receipt_Counts WHERE account_id='a'").get().n,2);
    for(const mutation of [
      "INSERT INTO Member_Playlist_Songs VALUES ('p2','s3',0,1)",
      "INSERT OR IGNORE INTO Member_Playlist_Songs VALUES ('p2','s3',0,1)",
      "UPDATE Member_Playlist_Songs SET sort_order=3 WHERE playlist_id='p1' AND song_id='s1'",
      "UPDATE Member_Playlist_Songs SET song_id='s3' WHERE playlist_id='p1' AND song_id='s1'",
      "UPDATE Member_Playlist_Songs SET playlist_id='p2' WHERE playlist_id='p1' AND song_id='s2'",
      "UPDATE Member_Playlists SET account_id='b' WHERE id='p2'",
      "INSERT INTO Member_Play_Events VALUES ('b','e3','s3',1,1)",
      "INSERT INTO Member_Play_Events VALUES ('b','e3','s3',1,1) ON CONFLICT DO NOTHING",
      "UPDATE Member_Play_Events SET account_id='b' WHERE account_id='a' AND event_id='e2'",
      "DELETE FROM Member_Play_Events WHERE received_at<2",
      "INSERT INTO Member_Play_Events VALUES ('a','e4','s3',3,3)",
      "DELETE FROM Songs WHERE id='s3'",
      "DELETE FROM Member_Playlists WHERE id='p2'",
      "DELETE FROM accounts WHERE account_id='b'",
    ]){db.exec(mutation);verify(db);}
    db.exec(sql);verify(db);
    assert.ok(hasHotpathObjects(db.prepare("SELECT name FROM sqlite_master").all()));
  }finally{db.close();}
});
test('migration is atomic on failure and repeated execution repairs counts without duplicating schema',()=>{
  const db=fixture();try{
    const before=db.prepare('SELECT * FROM Member_Playlists').all();
    db.exec('BEGIN');assert.throws(()=>{db.exec(sql);db.exec('INSERT INTO missing_fixture_table VALUES (1)');});db.exec('ROLLBACK');
    assert.deepEqual(db.prepare('SELECT * FROM Member_Playlists').all(),before);
    assert.equal(hasHotpathObjects(db.prepare('SELECT name FROM sqlite_master').all()),false);
    db.exec(sql);db.exec(sql);verify(db);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name IN (${HOTPATH_OBJECTS.map(()=>'?').join(',')})`).get(...HOTPATH_OBJECTS).n,HOTPATH_OBJECTS.length);
    db.exec('BEGIN');db.exec("INSERT INTO Member_Play_Events VALUES ('a','rollback','s1',5,5)");db.exec('ROLLBACK');verify(db);
    assert.equal(db.prepare("SELECT receipt_count n FROM Member_Play_Receipt_Counts WHERE account_id='a'").get().n,2);
  }finally{db.close();}
});
