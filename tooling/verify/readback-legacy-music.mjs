import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstanceState } from '../../server/src/instance/state.js';
import { handleLocalMusicReadRoute } from '../../server/src/routes/localMusicRead.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoot = resolve(root, '.tmp');
const target = process.argv[2] && resolve(process.argv[2]);
const accountId = process.argv[3];
const rel = target && relative(tempRoot, target);
if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || !accountId) {
  throw new Error('Provide a local .tmp SQLite target and an explicit target account ID.');
}

const sqlite = new DatabaseSync(target, { readOnly: true });
const adapter = {
  prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    };
  },
};
const read = async (path) => {
  const url = new URL(path, 'https://local-readback.invalid');
  const response = await handleLocalMusicReadRoute(new Request(url), url, adapter, {}, accountId);
  assert.equal(response?.status, 200, `${url.pathname} readback failed`);
  const body = await response.json();
  assert.equal(body.code, 200);
  return body.data;
};

try {
  assert.equal((await resolveInstanceState(adapter)).state, 'ready');
  const init = await read('/api/init');
  const personalCount = sqlite.prepare("SELECT COUNT(*) AS n FROM Member_Playlists WHERE account_id = ? AND kind = 'regular'")
    .get(accountId).n;
  const systemCount = sqlite.prepare('SELECT COUNT(*) AS n FROM Playlists').get().n;
  assert.equal(init.other_playlists.length, personalCount + systemCount);
  const favorite = sqlite.prepare("SELECT id FROM Member_Playlists WHERE account_id = ? AND kind = 'favorite'")
    .get(accountId);
  const favoriteCount = favorite ? sqlite.prepare('SELECT COUNT(*) AS n FROM Member_Playlist_Songs WHERE playlist_id = ?')
    .get(favorite.id).n : 0;
  assert.equal(init.default_playlist.songs.length, favoriteCount);
  const firstPersonal = sqlite.prepare("SELECT id FROM Member_Playlists WHERE account_id = ? AND kind = 'regular' ORDER BY id LIMIT 1")
    .get(accountId);
  if (firstPersonal) {
    const detail = await read(`/api/playlists/${encodeURIComponent(firstPersonal.id)}`);
    const expected = sqlite.prepare('SELECT COUNT(*) AS n FROM Member_Playlist_Songs WHERE playlist_id = ?')
      .get(firstPersonal.id).n;
    assert.equal(detail.songs.length, expected);
  }
  const firstSong = sqlite.prepare('SELECT id FROM Songs ORDER BY id LIMIT 1').get();
  if (firstSong) assert.equal((await read(`/api/songs/${encodeURIComponent(firstSong.id)}`)).id, firstSong.id);
  process.stdout.write(`${JSON.stringify({ state: 'ready', accountMapped: true, systemPlaylists: systemCount,
    personalPlaylists: personalCount, favoriteSongs: favoriteCount, songDetailChecked: Boolean(firstSong) })}\n`);
} finally {
  sqlite.close();
}
