import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, createBackgroundScheduler, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

const flatten = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(flatten)] : [];

test('album background failure retains readable tracks and offers local retry without leaking them into a different album', async () => {
  const requests = [];
  const album = { title: 'Saved album', songs: [{ id: 'track' }] };
  const harness = createBackgroundModuleHarness({ file: new URL('./AlbumDetailView.jsx', import.meta.url),
    modules: {
      '../hooks/useMusicSourcesRevision.js': { useMusicSourcesRevision: () => 0 },
      '../services/musicSources.js': { getMusicSourcesRevision: () => 0 },
      '../utils/musicSource.js': { isYouTubeEntity: () => false },
      '../i18n/index.js': { t: value => value }, 'lucide-react': { Play: 'play' },
      '../services/catalogRead.js': { peekCachedAlbum: id => id === 'one' ? album : null,
        readAlbum: id => new Promise((resolve, reject) => requests.push({ id, resolve, reject })) },
      './catalog/CollectionDetailSkeleton.jsx': 'skeleton', './SettingsControls.jsx': { SettingsButton: 'button' },
      './LazyImage.jsx': 'image', './TrackRow.jsx': 'track', './catalog/CollectionDetailPage.jsx': 'collection', './PageBackButton.jsx': 'back',
      '../utils.js': { resolveCoverUrl: value => value },
    }, globals: { AbortController } });
  const props = { id: 'one', isSongLiked: () => false };
  let tree = harness.render(props); assert.equal(tree.type, 'collection'); assert.equal(flatten(tree).some(node => node.type === 'track'), true);
  requests[0].reject(new Error('offline')); await flushBackgroundAsync(); tree = harness.render();
  assert.equal(tree.type, 'collection'); assert.equal(tree.props.title, 'Saved album');
  assert.equal(flatten(tree).some(node => node.props?.role === 'alert'), true);
  flatten(tree).find(node => node.type === 'button' && node.props.children.includes('重试')).props.onClick();
  harness.render(); assert.equal(requests.length, 2);
  requests[1].resolve(album); await flushBackgroundAsync(); tree = harness.render();
  assert.equal(flatten(tree).some(node => node.props?.role === 'alert'), false);
  tree = harness.render({ ...props, id: 'two' }); assert.equal(tree.type, 'skeleton');
  harness.unmount();
});

test('listening stats distinguish first load from refresh and retain the last authoritative list on failure', async () => {
  const requests = [];
  const state = { ownerSubject: 'first', identityReady: true, topSongs: [{ id: 'cached', title: 'Cached partial' }],
    setDetailViewActive() {}, refreshRemoteStats: () => new Promise(resolve => requests.push(resolve)) };
  const usePlayStatsStore = selector => selector(state); usePlayStatsStore.getState = () => state;
  const harness = createBackgroundModuleHarness({ file: new URL('./PlayStatsDetailView.jsx', import.meta.url),
    modules: { 'lucide-react': { RefreshCw: 'refresh' }, '../i18n/index.js': { t: value => value },
      '../utils': { hydrateSong: value => value }, '../store/usePlayStatsStore.js': { usePlayStatsStore },
      './PageBackButton.jsx': 'back', './TrackRow.jsx': 'track', './catalog/CatalogSkeleton.jsx': 'skeleton' }, globals: {} });
  let tree = harness.render({ songsMap: {} }); assert.equal(flatten(tree).some(node => node.type === 'skeleton'), true);
  assert.equal(flatten(tree).some(node => node.type === 'track'), false, 'persisted partial stats are not treated as an authoritative first view');
  state.topSongs = [{ id: 'one', title: 'Remote' }]; requests[0]({ ok: true }); await flushBackgroundAsync();
  tree = harness.render(); assert.equal(flatten(tree).filter(node => node.type === 'track').length, 1);
  flatten(tree).find(node => node.type === 'button').props.onClick(); tree = harness.render();
  assert.equal(flatten(tree).filter(node => node.type === 'track').length, 1, 'refresh keeps the verified songs usable');
  requests[1]({ ok: false }); await flushBackgroundAsync(); tree = harness.render();
  assert.equal(flatten(tree).filter(node => node.type === 'track').length, 1); assert.equal(flatten(tree).some(node => node.props?.role === 'alert'), true);
  state.ownerSubject = 'second'; tree = harness.render(); assert.equal(flatten(tree).some(node => node.type === 'track'), false, 'account switches do not inherit the old verified list');
  harness.unmount();
});

test('queue exposes keyboard-activatable songs and bounded arrow-key reordering through existing store actions', () => {
  const scheduler = createBackgroundScheduler(); const played = [], moved = [];
  const player = { playlist: [{ id: 'one', title: 'One', artist: 'Artist' }, { id: 'two', title: 'Two', artist: 'Artist' }],
    currentSong: { id: 'one' }, isPlaying: false, playSong: song => played.push(song.id), reorderPlaylist: (...args) => moved.push(args) };
  const usePlayerStore = selector => selector(player);
  const harness = createBackgroundModuleHarness({ file: new URL('./PlaylistDrawer.jsx', import.meta.url),
    modules: { '../i18n/index.js': { t: (value, vars = {}) => value.replace(/\{(\w+)\}/g, (_all, key) => vars[key] ?? key) },
      'lucide-react': {}, '../store/usePlayerStore': { usePlayerStore },
      '../store/useUIStore': { useUIStore: selector => selector({ isPlaylistOpen: true, setIsPlaylistOpen() {}, authSession: { authenticated: true } }) },
      './QualityBadge': 'quality', './LazyImage': 'image', 'zustand/react/shallow': { useShallow: selector => selector },
      '../hooks/useVerticalReorderDrag.js': () => ({ clearDrag() {}, getRowStyle: () => ({}) }),
      './drawers/DrawerFrame': 'drawer', './drawers/useDrawerTransition': { useDrawerTransition: () => ({ mounted: true, visible: true }) },
      '../plugins/contributions.js': { usePluginContribution: () => ({ available: false }) },
    }, globals: { ...scheduler, document: { activeElement: null }, window: { addEventListener() {}, removeEventListener() {} }, HTMLElement: class {} } });
  const tree = harness.render(); const buttons = flatten(tree).filter(node => node.type === 'button');
  const song = buttons.find(node => node.props['aria-label'] === '播放 Two - Artist');
  assert.ok(song, 'playing a queue item is exposed as a native button'); song.props.onClick(); assert.deepEqual(played, ['two']);
  const handle = buttons.find(node => node.props['aria-label'] === '调整 One 排序，使用上下方向键移动');
  let prevented = 0; const press = key => handle.props.onKeyDown({ key, preventDefault: () => prevented++, stopPropagation() {} });
  press('ArrowUp'); assert.equal(moved.length, 0); press('ArrowDown'); assert.deepEqual(moved, [[0, 1]]); assert.equal(prevented, 2);
  harness.unmount();
});

test('empty personal playlist routes to search when the optional assistant is unavailable', () => {
  let searches = 0, assistants = 0;
  const harness = createBackgroundModuleHarness({ file: new URL('./PlaylistDetailView.jsx', import.meta.url),
    modules: { '../i18n/index.js': { t: value => value }, 'lucide-react': {},
      '../hooks/usePlaylistEditor.js': () => ({ isEditing: false }), './LazyImage': 'image', './PlaylistEditableTracks.jsx': 'editor',
      './PageBackButton.jsx': 'back', './PlaylistCover': 'cover', './TrackRow': 'track', './UserImageEditor.jsx': 'image-editor',
      './PlaylistDetailSupport.jsx': { cleanPlaylistDescription: value => value, PendingPlaylistDetail: 'pending', PlaylistDescriptionDrawer: 'description' },
      '../accountPlaylists.js': {}, '../constants/roamLanguages.js': { localizeLibraryPlaylist: (playlist, info) => ({ playlist, info }) } }, globals: {} });
  const props = { isViewingPlaylist: true, playlist: { id: 'empty', kind: 'regular', name: 'Empty' }, playlistInfo: {},
    playlistSongs: [], isPersonalPlaylist: true, onOpenSearch: () => searches++, onOpenAssistant: () => assistants++ };
  let tree = harness.render(props);
  flatten(tree).find(node => node.type === 'button' && node.props.className.includes('local-playlist-empty__action')).props.onClick();
  assert.equal(searches, 1); assert.equal(assistants, 0);
  tree = harness.render({ ...props, assistantAvailable: true });
  flatten(tree).find(node => node.type === 'button' && node.props.className.includes('local-playlist-empty__action')).props.onClick();
  assert.equal(assistants, 1); harness.unmount();
});

test('library cold load has structure, and create failures preserve correctly labelled inputs and associated error text', async () => {
  const harness = createBackgroundModuleHarness({ file: new URL('./AllPlaylistsView.jsx', import.meta.url),
    modules: { '../i18n/index.js': { t: value => value }, 'react-dom': { createPortal: tree => tree, flushSync: fn => fn() }, 'lucide-react': {},
      './PlaylistShelfGrid.jsx': 'shelf', './PlaylistCover.jsx': 'cover', './PageBackButton.jsx': 'back',
      '../accountPlaylists.js': { useAccountPlaylists: selector => selector({ playlists: [] }),
        accountPlaylistsStore: { getState: () => ({ createPlaylist: async () => { throw new Error('offline'); } }) } },
      '../store/useUIStore.js': { showToast() {} }, './catalog/CatalogSkeleton.jsx': 'skeleton',
      '../hooks/useModalFocus.js': { useModalFocus() {} } },
    globals: { document: { body: {} }, window: { addEventListener() {}, removeEventListener() {} }, clearTimeout } });
  const props = { playlists: [], isAuthenticated: true, accountStatus: 'loading' };
  let tree = harness.render(props); assert.equal(flatten(tree).some(node => node.type === 'skeleton'), true);
  tree = harness.render({ ...props, accountStatus: 'ready' });
  flatten(tree).find(node => node.type === 'shelf').props.appendChild.props.onClick(); tree = harness.render();
  const name = flatten(tree).find(node => node.props?.id === 'create-playlist-name');
  assert.ok(flatten(tree).some(node => node.type === 'label' && node.props.htmlFor === name.props.id));
  name.props.onChange({ target: { value: 'My draft' } }); tree = harness.render();
  await flatten(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); tree = harness.render();
  const field = flatten(tree).find(node => node.props?.id === 'create-playlist-name');
  assert.equal(field.props.value, 'My draft'); assert.equal(field.props['aria-invalid'], undefined, 'network failure does not falsely mark a valid name invalid');
  const error = flatten(tree).find(node => node.props?.id === field.props['aria-describedby']);
  assert.equal(error.props.role, 'alert'); assert.equal(error.props.children[0], 'offline');
  harness.unmount();
});
