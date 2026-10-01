// Local-only browser fixture: real React consumers, synthetic media and API data.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import SearchView from '../../client/src/components/SearchView.jsx';
import LazyImage from '../../client/src/components/LazyImage.jsx';
import PrivateCoverImage from '../../client/src/components/PrivateCoverImage.jsx';
import RetainedPage from '../../client/src/components/RetainedPage.jsx';
import HomeOverview from '../../client/src/components/HomeOverview.jsx';
import { imageLoadRegistry } from '../../client/src/utils/imageLoadRegistry.js';
import { useUIStore } from '../../client/src/store/useUIStore.js';
import { createSearchPageCache } from '../../client/src/utils/searchPageCache.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message) {
  for (let n = 0; n < 150; n++) { if (check()) return; await wait(20); }
  throw new Error(message);
}
function assert(ok, message) { if (!ok) throw new Error(message); }
const session = { authenticated: true, user: { accountId: 'fixture', username: 'fixture' }, csrfToken: 'fixture' };
const counts = { media: 0, search: 0, session: 0 };
let finishSession; let holdSession = false;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#cc7744"/></svg>';
const songs = Array.from({ length: 40 }, (_, id) => ({ id: id + 1, title: `Fixture ${id + 1}`, artist: 'Fixture Artist', language: 'en', cover_url: '/media/fixture.svg', audio_url: '/media/fixture.mp3', duration: 120 }));
globalThis.fetch = async (input) => {
  const url = new URL(input, location.origin);
  if (url.pathname.startsWith('/media/')) { counts.media++; return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } }); }
  if (url.pathname === '/api/auth/session') {
    counts.session++; if (!holdSession) return Response.json(session);
    return new Promise((resolve, reject) => { finishSession = (value = session) => value instanceof Error ? reject(value) : resolve(Response.json(value)); });
  }
  if (url.pathname === '/api/songs/search') {
    counts.search++;
    const offset = Number(url.searchParams.get('offset'));
    return Response.json({ data: { songs: songs.slice(offset, offset + 20) } });
  }
  if (url.pathname === '/api/artists') return Response.json({ data: { artists: Array.from({ length: 7 }, (_, i) => ({ name: `Artist ${i}`, coverUrl: '/media/fixture.svg' })), total: 7, hasMore: false } });
  if (url.pathname === '/api/albums') return Response.json({ data: { albums: [{ id: 'album', title: 'Fixture Album', name: 'Fixture Album', cover_url: '/media/fixture.svg' }], total: 1, hasMore: false } });
  return Response.json({ data: { photos: [] } });
};
useUIStore.setState({ authSession: session });
imageLoadRegistry.setSessionScope(session);
const cache = createSearchPageCache();
const root = createRoot(document.getElementById('fixture'));
let showSearch = true;
let showNewImage = false;
let homeActive = false;
let hiddenSource = '/media/fixture.svg';
let homeScope = 'fixture';
let route = { query: 'Fixture', view: 'overview', language: 'all' };
function render() {
  flushSync(() => root.render(<>
    <section id="player"><LazyImage src="/media/fixture.svg" eager style={{ width: 80, height: 80 }} /><PrivateCoverImage src="/media/fixture.svg" width="80" height="80" /></section>
    <section id="new-image">{showNewImage && <LazyImage src="/media/fixture.svg" eager />}</section>
    <section id="search">{showSearch ? <SearchView route={route} cache={cache} /> : <p>Artist detail</p>}</section>
    <section id="home"><RetainedPage key={homeScope} active={homeActive}>
      <HomeOverview favoritePlaylist={{ id: 'fav', kind: 'favorite' }} favoriteDetail={{ songs: songs.slice(0, 8) }}
        randomSongs={songs.slice(0, 3)} resolvedTopSongs={songs.slice(0, 8)} randomRoam={{ enabled: false }} />
      <div id="hidden-probe"><LazyImage src={hiddenSource} eager /></div>
    </RetainedPage></section>
  </>));
}
async function run() {
  document.getElementById('run').disabled = true;
  const results = [];
  const report = document.getElementById('report');
  const pass = (message) => { results.push(message); report.textContent = results.join('\n'); };
  try {
    history.replaceState(null, '', '/search?q=Fixture');
    render();
    await until(() => document.querySelector('#player .lazy-image')?.dataset.imageState === 'ready' && document.querySelectorAll('#search .track-row').length > 0, 'initial search/image did not load');
    await wait(850);
    holdSession = true;
    const original = [...document.querySelectorAll('#player img')];
    let changed = 0;
    const observer = new MutationObserver((records) => { changed += records.filter((r) => r.type === 'childList' || r.attributeName === 'src' || r.attributeName === 'data-image-state').length; });
    observer.observe(document.getElementById('player'), { subtree: true, childList: true, attributes: true });
    history.replaceState(null, '', '/library');
    imageLoadRegistry.invalidateRoute();
    await until(() => finishSession, 'route verification not started');
    showNewImage = true; render();
    await wait(120);
    assert(!document.querySelector('#new-image img'), 'new mount bypassed pending route verification');
    assert(original.every((img) => img.isConnected && img.src.startsWith('blob:') && img.naturalWidth > 0), 'mounted player image hidden during verification');
    finishSession(); finishSession = null; holdSession = false;
    await wait(100);
    assert(changed === 0, `player changed ${changed} times during navigation`);
    assert(counts.media === 1, 'duplicate media download');
    observer.disconnect();
    pass('PASS: two mounted player consumers retain the same DOM/src with zero placeholder transitions and one shared media GET.');

    const preview = [...document.querySelectorAll('#search img')];
    route = { ...route, view: 'artists' }; render();
    await wait(100);
    assert(preview.every((img) => img.isConnected), 'overview images removed on full artist list: ' + preview.filter((img) => !img.isConnected).map((img) => img.alt).join(','));
    route = { ...route, view: 'overview' }; render();
    await wait(100);
    assert(preview.every((img) => img.isConnected), 'overview images replaced on return');
    assert(counts.search === 1, 'full artist round trip re-searched songs');
    pass('PASS: overview → full artists → overview retains all overview image nodes without another song search.');

    route = { ...route, view: 'songs' }; render();
    await wait(100);
    const more = [...document.querySelectorAll('#search button')].find((button) => button.textContent.includes('加载更多'));
    assert(more, 'load more missing'); more.click();
    await until(() => counts.search === 2 && cache.get('["Fixture","all"]')?.songs.length === 40, 'expanded page not cached');
    showSearch = false; render();
    await wait(50);
    showSearch = true; render();
    assert(document.querySelector('.full-song-grid')?.children.length === 40, 'expanded results not restored synchronously');
    await wait(850);
    assert(counts.search === 2, 'returning from artist detail triggered another search');
    pass('PASS: unmount → remount restores 40 songs synchronously, including pagination; no new search after debounce.');

    assert(!document.querySelector('#home .home-overview'), 'home mounted before first visit');
    homeActive = true; render();
    await until(() => document.querySelectorAll('#home img').length > 3, 'home images not loaded');
    document.querySelector('#home [aria-labelledby="home-footprints-title"]').scrollIntoView();
    await until(() => document.querySelector('#home button[aria-haspopup="menu"]'), 'home song menu button missing');
    document.querySelector('#home button[aria-haspopup="menu"]').click();
    await until(() => document.querySelector('[role="menu"]'), 'home menu did not open');
    const homeImages = [...document.querySelectorAll('#home .home-overview img')];
    homeActive = false; render();
    await wait(100);
    assert(!document.querySelector('[role="menu"]'), 'hidden home left its portal menu on the next page');
    assert(homeImages.every((img) => img.isConnected), 'hidden home unmounted images');
    const beforeHiddenLoad = counts.media;
    hiddenSource = '/media/hidden-only.svg'; render();
    await wait(100);
    assert(counts.media === beforeHiddenLoad, 'hidden home downloaded changed cover');
    hiddenSource = '/media/fixture.svg'; homeActive = true; render();
    await wait(100);
    assert(homeImages.every((img) => img.isConnected), 'returning home replaced images');
    assert(!document.querySelector('[role="menu"]'), 'returning home reopened an old menu');
    pass('PASS: real HomeOverview mounts on demand, retains its image DOM across visits, and does not download changed covers while hidden.');
    homeActive = false; homeScope = 'different-session'; render();
    assert(homeImages.every((img) => !img.isConnected), 'session-key change retained prior home DOM');
    pass('PASS: changing the home session key discards all prior image nodes.');

    const oldBlob = document.querySelector('#player img').src;
    holdSession = true;
    history.replaceState(null, '', '/network-failure'); imageLoadRegistry.invalidateRoute();
    await until(() => finishSession, 'network verification missing');
    finishSession(new Error('fixture offline')); finishSession = null;
    await until(() => ![...document.querySelectorAll('#player img')].some((img) => img.src === oldBlob), 'network failure retained old Blob while fallback loads');
    history.replaceState(null, '', '/after-network-failure'); imageLoadRegistry.invalidateRoute();
    await until(() => finishSession, 'recovery verification missing');
    assert(![...document.querySelectorAll('#player img')].some((img) => img.src === oldBlob), 'next navigation restored failed Blob');
    finishSession(); finishSession = null; holdSession = false;
    await until(() => document.querySelector('#player .lazy-image')?.dataset.imageState === 'ready', 'recovery did not load fresh cover');
    pass('PASS: network failure revokes old Blob immediately, even with delayed fallback; next navigation cannot revive it.');

    const beforeRenewal = document.querySelector('#player img').src;
    imageLoadRegistry.setSessionScope({ ...session, csrfToken: 'renewed' });
    await until(() => document.querySelector('#player .lazy-image')?.dataset.imageState === 'ready' && document.querySelector('#player img')?.src !== beforeRenewal, 'same-path renewal retained old Blob');
    imageLoadRegistry.setSessionScope(session);
    await until(() => document.querySelector('#player .lazy-image')?.dataset.imageState === 'ready', 'session reset did not reload');
    pass('PASS: same-path session renewal replaces the old Blob.');

    holdSession = true;
    history.replaceState(null, '', '/settings'); imageLoadRegistry.invalidateRoute();
    await until(() => finishSession, 'rejection verification missing');
    finishSession({ authenticated: false }); finishSession = null;
    await until(() => ![...document.querySelectorAll('#player img')].some((img) => img.src.startsWith('blob:')), 'rejected session retained private images');
    pass('PASS: rejected session removes both mounted private Blob images.');
    report.textContent += `\nALL PASSED ${JSON.stringify(counts)}`;
  } catch (error) { report.textContent += `\nFAIL: ${error.stack}`; }
}
document.getElementById('run').onclick = run;
