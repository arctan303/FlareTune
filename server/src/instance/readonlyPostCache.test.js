import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../subsonic/test-support.js';

const request = (f, path, extra = {}) => f.api(path, 'POST', path.endsWith('resolve')
  ? {song_ids:['s1']} : {strategy:'recent',recentSongIds:[],queuedSongIds:[],limit:2}, f.signed, extra);

test('only allowlisted read-only POSTs reuse structure, while writes refresh and invalidate failure', async () => {
  const f = await fixture();
  try {
    assert.equal((await request(f,'songs/resolve')).status,200);
    f.db.queries.length = 0;
    assert.equal((await request(f,'songs/roam')).status,200);
    assert.equal((await request(f,'songs/resolve')).status,200);
    assert.ok(f.db.queries.every(sql=>!sql.includes('sqlite_master')&&!sql.startsWith('PRAGMA')));
    assert.equal((await f.api('account/play-stats','POST',{events:[]})).status,200);
    assert.ok(f.db.queries.some(sql=>sql.includes('sqlite_master')));
    f.sqlite.exec('DROP TRIGGER ft_member_playlist_owner_count');
    assert.equal((await request(f,'songs/resolve')).status,200);
    assert.equal((await f.api('account/play-stats','POST',{events:[]})).status,503);
    assert.equal((await request(f,'songs/resolve')).status,503);
  } finally { await f.close(); }
});

test('warm read-only POST structure never caches CSRF, identity, maintenance or revoked sessions', async () => {
  const f = await fixture();
  try {
    for (const path of ['songs/roam','songs/resolve']) {
      assert.equal((await request(f,path)).status,200);
      assert.equal((await request(f,path,{'X-CSRF-Token':'invalid'})).status,403);
      assert.equal((await request(f,path,{Origin:'https://foreign.example'})).status,403);
      assert.equal((await request(f,path,{'X-FlareTune-Expected-Account':'another-account'})).status,409);
      f.sqlite.prepare('UPDATE ft_migration_lock SET owner_token=?,lease_expires_at=? WHERE id=1')
        .run('a'.repeat(32),Date.now()+60_000);
      assert.equal((await request(f,path)).status,503);
      f.sqlite.exec('UPDATE ft_migration_lock SET owner_token=NULL,lease_expires_at=0 WHERE id=1');
      assert.equal((await request(f,path)).status,200);
    }
    f.sqlite.exec('DELETE FROM account_sessions');
    for (const path of ['songs/roam','songs/resolve']) assert.equal((await request(f,path)).status,401);
  } finally { await f.close(); }
});
