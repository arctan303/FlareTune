import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountPlaylistError } from '../services/accountPlaylists.js';
import { executeManagePlaylist, managePlaylistTool } from './managePlaylist.js';

const makeServices = () => ({
  listPlaylists: async () => ({ playlists: [{ id: 'fav', kind: 'favorite', revision: 1 }] }),
  getPlaylist: async () => ({ id: 'fav', name: '我喜欢', revision: 1, songs: [{ id: 's1' }, { id: 's2' }] }),
  createPlaylist: async () => ({ playlist: { id: 'p1', name: '夜航' }, shelf: { revision: 1 } }),
  addSongsToPlaylists: async () => ({ outcome: 'noop', results: [], affectedPlaylistIds: [] }),
  replacePlaylistSongs: async (_db, _sub, id, songIds) => ({ outcome: 'applied', playlist: { id, revision: 2, songs: songIds.map((songId) => ({ id: songId })) } }),
  clearPlaylistSongs: async () => ({ outcome: 'applied', playlist: { id: 'fav', revision: 2, songs: [] } }),
  updatePlaylist: async () => ({ outcome: 'applied', playlist: { id: 'fav', revision: 2 } }),
  deletePlaylist: async () => ({ outcome: 'applied', deletedPlaylistId: 'p1', shelf: { revision: 2 } }),
});

test('manage_playlist exposes all server actions and is not a client-only tool', () => {
  assert.deepEqual(managePlaylistTool.parameters.properties.action.enum, [
    'list', 'read', 'create', 'add_songs', 'remove_songs', 'clear', 'replace_songs', 'reorder_songs', 'update_metadata', 'delete',
  ]);
  assert.equal(managePlaylistTool.clientOnly, undefined);
});

test('manage_playlist returns the exact auth error before reading personal data', async () => {
  let touched = false;
  const service = new Proxy({}, { get() { touched = true; throw new Error('must not read'); } });
  const output = await executeManagePlaylist({ action: 'list' }, { user: null, db: {} }, service);
  assert.deepEqual(output.eventData, {
    ok: false,
    outcome: 'failed',
    error: 'AUTH_REQUIRED',
    message: '需要登录账号才能管理个人歌单。',
  });
  assert.equal(touched, false);
});

test('manage_playlist routes every action through the account playlist service', async () => {
  const service = makeServices();
  let createOptions = null;
  service.createPlaylist = async (...args) => {
    createOptions = args[4];
    return { outcome: 'applied', playlist: { id: 'p1', name: '夜航' }, shelf: { revision: 1 } };
  };
  const context = { user: { subject: 'member-a' }, db: { marker: true }, toolCallId: 'call-create-1' };
  const cases = [
    { action: 'list' },
    { action: 'read', playlist_id: 'fav' },
    { action: 'create', name: '夜航' },
    { action: 'add_songs', playlist_id: 'fav', song_ids: ['s1'], expected_revision: 1 },
    { action: 'remove_songs', playlist_id: 'fav', song_ids: ['s1'], expected_revision: 1 },
    { action: 'clear', playlist_id: 'fav', expected_revision: 1 },
    { action: 'replace_songs', playlist_id: 'fav', song_ids: ['s2'], expected_revision: 1 },
    { action: 'reorder_songs', playlist_id: 'fav', song_ids: ['s2', 's1'], expected_revision: 1 },
    { action: 'update_metadata', playlist_id: 'fav', name: '新名', expected_revision: 1 },
    { action: 'delete', playlist_id: 'p1', expected_revision: 0 },
  ];
  for (const args of cases) {
    const output = (await executeManagePlaylist(args, context, service)).eventData;
    assert.equal(output.ok, true, args.action);
    assert.equal(output.action, args.action);
  }
  assert.equal(createOptions.idempotencyKey, 'call-create-1');
});

test('manage_playlist reports an idempotent create replay as noop', async () => {
  const service = makeServices();
  service.createPlaylist = async () => ({ outcome: 'noop', playlist: { id: 'p1', name: '夜航' }, shelf: { revision: 1 } });
  const output = (await executeManagePlaylist(
    { action: 'create', name: '夜航' },
    { user: { subject: 'member-a' }, db: {}, toolCallId: 'call-create-1' },
    service,
  )).eventData;
  assert.equal(output.outcome, 'noop');
  assert.deepEqual(output.affectedPlaylistIds, []);
});

test('manage_playlist preserves account service conflicts and validates complete reorder input', async () => {
  const service = makeServices();
  service.updatePlaylist = async () => { throw new AccountPlaylistError('REVISION_CONFLICT', '歌单已更新。', { playlist: { revision: 3 } }); };
  const context = { user: { subject: 'member-a' }, db: {} };
  const conflict = (await executeManagePlaylist({ action: 'update_metadata', playlist_id: 'fav', name: 'X', expected_revision: 1 }, context, service)).eventData;
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'REVISION_CONFLICT');
  assert.equal(conflict.data.playlist.revision, 3);

  const invalid = (await executeManagePlaylist({ action: 'reorder_songs', playlist_id: 'fav', song_ids: ['s1'], expected_revision: 1 }, context, service)).eventData;
  assert.equal(invalid.error, 'INVALID_BODY');
});

test('manage_playlist auto-resolves revision when expected_revision is omitted', async () => {
  const service = makeServices();
  let receivedRevision = null;
  service.addSongsToPlaylists = async (_db, _sub, input) => {
    receivedRevision = input.targets[0].expectedRevision;
    return { outcome: 'applied', results: [], affectedPlaylistIds: ['fav'] };
  };
  const context = { user: { subject: 'member-a' }, db: {} };
  const output = (await executeManagePlaylist({
    action: 'add_songs',
    playlist_id: 'fav',
    song_ids: ['s1'],
  }, context, service)).eventData;

  assert.equal(output.ok, true);
  assert.equal(receivedRevision, 1);
});

test('manage_playlist auto-resolves song titles to song IDs from database', async () => {
  const service = makeServices();
  let receivedSongIds = null;
  service.addSongsToPlaylists = async (_db, _sub, input) => {
    receivedSongIds = input.songIds;
    return { outcome: 'applied', results: [], affectedPlaylistIds: ['fav'] };
  };
  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT id FROM Songs WHERE id = ?')) {
                if (args[0] === 's1') return { id: 's1' };
                return null;
              }
              if (sql.includes('SELECT id FROM Songs WHERE LOWER(title)')) {
                if (args[0] === 'the nights') return { id: 's_nights' };
                return null;
              }
              return null;
            },
          };
        },
      };
    },
  };
  const context = { user: { subject: 'member-a' }, db: mockDb };
  const output = (await executeManagePlaylist({
    action: 'add_songs',
    playlist_id: 'fav',
    song_ids: ['s1', '《The Nights》'],
  }, context, service)).eventData;

  assert.equal(output.ok, true);
  assert.deepEqual(receivedSongIds, ['s1', 's_nights']);
});
