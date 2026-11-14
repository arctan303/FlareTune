import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../subsonic/test-support.js';
import { pluginRegistry } from '../plugins/registry.js';

const build = () => {
  const digest = pluginRegistry.getBuildDigest('roam');
  assert.match(digest || '', /^[a-f0-9]{64}$/u, 'compiled roam must carry a source fingerprint');
  return digest;
};
const installRoam = (f, installed = true, revision = 0) => pluginRegistry.setInstalled(f.env, f.signed.session,
  'roam', { installed, revision });

const request = (f, path, extra = {}) => f.api(path, 'POST', path.endsWith('resolve')
  ? {song_ids:['s1']} : {strategy:'recent',recentSongIds:[],queuedSongIds:[],limit:2}, f.signed,
  { ...(path.endsWith('resolve') ? {} : {'X-FlareTune-Plugin-Build':build()}), ...extra });

test('only allowlisted read-only POSTs reuse structure, while writes refresh and invalidate failure', async () => {
  const f = await fixture();
  try {
    await installRoam(f);
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
    await installRoam(f);
    for (const path of ['songs/roam','account/plugins/roam/sample','songs/resolve']) {
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
    for (const path of ['songs/roam','account/plugins/roam/sample','songs/resolve']) assert.equal((await request(f,path)).status,401);
  } finally { await f.close(); }
});

test('warm legacy and plugin POSTs recheck installation and build before every sample', async () => {
  const f = await fixture();
  try {
    const paths = ['songs/roam','account/plugins/roam/sample'];
    for (const path of paths) assert.equal((await request(f,path)).status,409);
    await installRoam(f);
    for (const path of paths) {
      assert.equal((await request(f,path)).status,200);
      assert.equal((await request(f,path,{'X-FlareTune-Plugin-Build':''})).status,409);
      assert.equal((await request(f,path,{'X-FlareTune-Plugin-Build':'old-build'})).status,409);
    }
    await installRoam(f,false,1);
    f.db.queries.length=0;
    for (const path of paths) {
      const response=await request(f,path);
      assert.equal(response.status,409);
      assert.deepEqual(await response.json(),{error:'PLUGIN_NOT_INSTALLED'});
    }
    assert.ok(f.db.queries.every(sql=>!/FROM Songs\b/u.test(sql)),'no cached result or fresh catalog batch after uninstall');
    assert.equal((await request(f,'songs/resolve')).status,200);
    assert.equal((await f.api('songs/random')).status,200);
    assert.equal((await f.api('songs/spotlight-artist')).status,200);
  } finally { await f.close(); }
});

test('both roam URLs keep account-only access and administrator-only installation over HTTP', async () => {
  const f = await fixture();
  try {
    const member = await f.signIn('member');
    const body = {strategy:'recent',recentSongIds:[],queuedSongIds:[],limit:2};
    const headers = {'X-FlareTune-Plugin-Build':build()};
    const paths = ['songs/roam','account/plugins/roam/sample'];
    for (const path of paths) {
      assert.equal((await f.api(path,'POST',body,member,headers)).status,409);
      assert.equal((await f.api(path,'POST',body,member,{...headers,Cookie:''})).status,401);
    }
    assert.equal((await f.api('admin/plugins/roam','PUT',{installed:true,revision:0},member)).status,403);
    assert.equal((await f.api('admin/plugins/roam','PUT',{installed:true,revision:0})).status,200);
    for (const path of paths) {
      assert.equal((await f.api(path,'POST',body,member,headers)).status,200);
      assert.equal((await f.api(path,'POST',body,f.signed,headers)).status,200);
    }
    assert.equal((await f.api('admin/plugins/roam','PUT',{installed:false,revision:1})).status,200);
    for (const path of paths) assert.equal((await f.api(path,'POST',body,member,headers)).status,409);
  } finally { await f.close(); }
});
