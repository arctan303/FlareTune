import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { formatPath, parsePathname } from '../utils/navigation.js';

function mainContent(available) {
  const seen = {}, returns = [], navigations = [];
  const capture = name => props => { seen[name] = props; return React.createElement('div', { 'data-view': name }); };
  const ui = { authSession: { authenticated: true, user: { accountId: 'fixture', role: 'member' }, csrfToken: 'fixture-session' },
    viewingPlaylistData: null, playlistSongs: [], playlistInfo: null, isViewingPlaylist: false,
    setViewingPlaylist() {}, closeViewingPlaylist() {}, isViewingAdmin: false, setIsViewingAdmin() {},
    isArtistDrawerOpen: false, setIsArtistDrawerOpen() {}, activeArtistData: null, setIsAccountPlaylistOpen() {}, openAddToPlaylist() {} };
  const useUIStore = Object.assign(select => select(ui), { getState: () => ui });
  const account = { playlists: [], details: {}, shelf: [], status: 'ready', error: null };
  const dependencies = {
    react: { ...React, lazy: () => capture('lazy-plugin-or-admin') },
    '../i18n/index.js': { t: key => key }, '../store/useUIStore': { useUIStore, showToast() {} },
    '../store/usePlayerStore': { usePlayerStore: select => select({ currentSong: null, isPlaying: false, playlist: [], playSong() {} }) },
    '../utils': { hydrateSong: song => song }, 'zustand/react/shallow': { useShallow: value => value },
    '../utils/expiringAsyncCache': { createLatestRequestGuard: () => ({ cancel() {} }) },
    '../accountPlaylists.js': { useAccountPlaylists: select => select(account), accountPlaylistsStore: { getState: () => ({}) }, isAccountPlaylistStaleError: () => false },
    '../accountPlaylistOrdering.js': { resolveVisibleShelfPlaylists: () => [] },
    '../services/playlistPayloadLoader.js': { createMemberPlaylistInfo() {}, loadPlaylistPayload() { throw Error('Unexpected playlist request'); } },
    '../hooks/useRandomSongs': { useRandomSongs: () => ({ songs: [], isLoading: false, refresh() {} }) },
    '../utils/searchPageCache.js': { createSearchPageCache: () => ({}) },
    './PlaylistCover.jsx': { getPlaylistCoverUrls: () => [], PLAYLIST_COVER_FALLBACK: 'placeholder' },
    '../utils/navigation.js': { formatPath, returnToOriginRoute: fallback => returns.push(fallback), syncBrowserHistory: url => navigations.push(url) },
    '../hooks/useFavoriteSongAction.js': { useFavoriteSongAction: () => ({ favoritePlaylist: null, favoriteDetail: null, favoriteSongIds: new Set(), toggleFavorite() {} }) },
    '../services/playerActions.js': { insertNextWithFeedback() {} },
    '../store/usePlayStatsStore.js': { usePlayStatsStore: select => select({ listeningPreview: [] }) },
    '../utils/topArtists.js': { deriveTopArtists: () => [] },
    '../services/dailyRecommendations.js': { createDailyRecommendationPlaylist: () => ({}) },
    '../plugins/contributions.js': { usePluginContribution: (_id, _slot, fallback) => available ? { available: true, actions: {} } : fallback },
    './RetainedPage.jsx': ({ active, children }) => active ? children : null,
    ...Object.fromEntries(['SearchView', 'PlaylistDetailView', 'AllPlaylistsView', 'HomeOverview', 'PlayHistoryView', 'PlayStatsDetailView',
      'SettingsView', 'ArtistDetailView', 'AlbumDetailView', 'CatalogBrowserView', 'RoamBrowseView', 'PageBackButton']
      .map(name => [`./${name}.jsx`, capture(name)])),
    './catalog/ArtistCard.jsx': capture('ArtistCard'),
  };
  const code = transformSync(readFileSync(new URL('./MainContent.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => {
    if (!(id in dependencies)) throw Error(`Unmocked Host dependency: ${id}`);
    return dependencies[id];
  }, module, module.exports);
  return { seen, returns, navigations, render(route) {
    for (const key of Object.keys(seen)) delete seen[key];
    return renderToStaticMarkup(React.createElement(module.exports.default, { myPlaylists: [], likedSongs: [], songsMap: new Map(),
      activePage: route.page || 'roam', activeRoute: route, onNavigate() {}, scrollContainerRef: { current: null } }));
  } };
}

test('both roam URLs render the normal Host browse view without a plugin workspace regardless of installation', () => {
  for (const available of [false, true]) for (const path of ['/roam', '/plugins/roam/browse']) {
    const view = mainContent(available), html = view.render(parsePathname(path));
    assert.match(html, /data-view="RoamBrowseView"/);
    assert.equal(view.seen['lazy-plugin-or-admin'], undefined);
  }
});

test('classification back and the home browse link always reach roam even when the plugin is absent', () => {
  for (const available of [false, true]) {
    const view = mainContent(available);
    view.render({ type: 'explore', language: 'zh', view: 'overview' });
    view.seen.CatalogBrowserView.onBack(); assert.deepEqual(view.returns, ['/roam']);
    view.render({ type: 'page', page: 'home' });
    view.seen.HomeOverview.onNavigateRoam(); assert.deepEqual(view.navigations, ['/roam']);
  }
});
