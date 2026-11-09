import assert from 'node:assert/strict';
import test from 'node:test';
import { isYouTubeEntity, canUseLocalSongLibrary, canReferenceAccountSong, songSourceMetadata, artistIdentity, artistFromSong, youtubeSearchWarning } from './musicSource.js';
import { parsePathname, formatPath } from './navigation.js';
import { saveRecentSearchEntity, loadRecentSearchEntities, removeRecentSearchEntity } from './searchHistory.js';

test('YouTube identity survives metadata-only queues and does not turn local ids into YouTube ids', () => {
  assert.equal(isYouTubeEntity('yt:QBtVFL0Qefs'), true);
  assert.equal(isYouTubeEntity({ id: 'yt:QBtVFL0Qefs' }), true);
  assert.equal(isYouTubeEntity({ source: 'youtube' }), true);
  assert.equal(canUseLocalSongLibrary({ id: 'yt:QBtVFL0Qefs' }), false);
  assert.equal(canUseLocalSongLibrary({ id: 'local', source: 'r2' }), true);
  assert.equal(canUseLocalSongLibrary('local'), true);
});

test('the same named local and YouTube artists retain separate deep links and histories', () => {
  const yt = { id: 'yt:artist:UCsame', name: 'Same Artist', source: 'youtube' };
  const local = { name: 'Same Artist' };
  assert.notEqual(artistIdentity(yt), artistIdentity(local));
  const url = formatPath({ type: 'artist', ...yt, view: 'albums' });
  assert.equal(url, '/artist/yt%3Aartist%3AUCsame/albums');
  assert.deepEqual(parsePathname(url), { type: 'artist', name: yt.id, id: yt.id, source: 'youtube', view: 'albums' });
  const before = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key), setItem: (key,value) => values.set(key,value) };
  try {
    saveRecentSearchEntity({ type: 'artist', ...local }, 'A');
    saveRecentSearchEntity({ type: 'artist', ...yt }, 'A');
    assert.equal(loadRecentSearchEntities('A').length, 2);
    saveRecentSearchEntity({ type: 'artist', ...yt, id: 'yt:artist:UCsAME' }, 'A');
    assert.equal(loadRecentSearchEntities('A').length, 3, 'upstream ids remain case sensitive');
    removeRecentSearchEntity({ type:'artist', id:'yt:artist:UCsAME', source:'youtube' }, 'A');
    removeRecentSearchEntity({ type: 'artist', ...yt }, 'A');
    assert.deepEqual(loadRecentSearchEntities('A'), [{ type: 'artist', ...local }]);
  } finally { globalThis.localStorage = before; }
});

test('song artist links preserve the upstream browse id, including raw upstream ids', () => {
  const song = { id: 'yt:QBtVFL0Qefs', artist: 'A', cover_url: '/media/youtube/image?url=x', artists: [{ id: 'UCa', name: 'A' }] };
  assert.deepEqual(artistFromSong(song), { id: 'yt:artist:UCa', name: 'A', source: 'youtube', coverUrl: song.cover_url });
  assert.equal(artistFromSong({ ...song, artists: [{ id: 'yt:artist:UCa', name: 'A' }] }).id, 'yt:artist:UCa');
});

test('YouTube source failures are visible while an unconfigured optional source remains quiet', () => {
  assert.equal(youtubeSearchWarning([{ source:'youtube', code:'not_configured' }]), '');
  assert.match(youtubeSearchWarning([{ source:'youtube', code:'unavailable' }]), /本地搜索结果/);
  assert.match(youtubeSearchWarning([{ source:'youtube', code:'rate_limited' }]), /频繁/);
  assert.equal(youtubeSearchWarning([{ source:'other', code:'unavailable' }]), '');
});


test('account references accept local and canonical YouTube songs without granting catalog editing', () => {
  for (const song of ['local', {id:'local'}, 'yt:QBtVFL0Qefs', {id:'yt:QBtVFL0Qefs',source:'youtube'}]) {
    assert.equal(canReferenceAccountSong(song),true);
  }
  assert.equal(canUseLocalSongLibrary('yt:QBtVFL0Qefs'),false);
  for (const bad of [null, '', {}, 'yt:artist:UCtest', 'yt:album:MPREb_a', 'yt:short', ' yt:short ', {id:'local',source:'youtube'}]) {
    assert.equal(canReferenceAccountSong(bad),false);
  }
});

test('browser source metadata retains public stable references without transient player fields', () => {
  const song={id:'yt:QBtVFL0Qefs',source:'youtube',sourceId:'wrong',artists:[{id:'yt:artist:UCtest',name:'A',privateValue:'omit'}],
    albumId:'yt:album:MPREb_a',url:'https://example.invalid/signed',accessToken:'omit'};
  assert.deepEqual(songSourceMetadata(song),{source:'youtube',sourceId:'QBtVFL0Qefs',
    artists:[{id:'yt:artist:UCtest',name:'A'}],albumId:'yt:album:MPREb_a'});
  assert.deepEqual(songSourceMetadata({id:'local'}),{});
});
