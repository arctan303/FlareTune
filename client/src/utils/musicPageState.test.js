import assert from 'node:assert/strict';
import test from 'node:test';
import { musicOverviewNeedsBootstrap } from './musicPageState.js';

test('music bootstrap only gates the two overview pages', () => {
  for (const activePage of ['home', 'library']) {
    assert.equal(musicOverviewNeedsBootstrap({ activePage, activeRoute: { type: 'page', page: activePage } }), true);
  }
  for (const activePage of ['settings', 'plugin', 'search', 'roam', 'history']) {
    assert.equal(musicOverviewNeedsBootstrap({ activePage, activeRoute: { type: 'page', page: activePage } }), false, activePage);
  }
  for (const type of ['playlist', 'album', 'artist', 'explore', 'top-songs', 'top-artists']) {
    assert.equal(musicOverviewNeedsBootstrap({ activePage: 'home', activeRoute: { type } }), false, type);
  }
  assert.equal(musicOverviewNeedsBootstrap({ activePage: 'home', isViewingAdmin: true }), false);
  assert.equal(musicOverviewNeedsBootstrap({ activePage: 'home', isArtistDrawerOpen: true }), false);
});
