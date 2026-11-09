import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePathname, parseAppLocation, formatPath, syncBrowserHistory, returnToOriginRoute, returnToParentRoute, returnFromSidebarWorkspace, restoreSidebarWorkspaceAfterRejectedBack, DEFAULT_PAGE } from './navigation.js';

test('parsePathname resolves root or empty string to default home page', () => {
  assert.deepEqual(parsePathname(''), { type: 'page', page: DEFAULT_PAGE });
  assert.deepEqual(parsePathname('/'), { type: 'page', page: DEFAULT_PAGE });
  assert.deepEqual(parsePathname('///'), { type: 'page', page: DEFAULT_PAGE });
});

test('parsePathname resolves standard primary pages', () => {
  assert.deepEqual(parsePathname('/home'), { type: 'page', page: 'home' });
  assert.deepEqual(parsePathname('/history'), { type: 'page', page: 'history' });
  assert.deepEqual(parsePathname('/search'), { type: 'page', page: 'search' });
  assert.deepEqual(parsePathname('/roam'), { type: 'page', page: 'roam' });
  assert.equal(formatPath({ type: 'page', page: 'roam' }), '/roam');
  assert.deepEqual(parsePathname('/library'), { type: 'page', page: 'library' });
  assert.deepEqual(parsePathname('/settings'), { type: 'page', page: 'settings', section: 'appearance' });
  assert.deepEqual(parsePathname('/assistant'), { type: 'page', page: 'plugin', pluginId: 'assistant', pluginPage: 'conversation' });
  assert.deepEqual(parsePathname('/xiaoa'), { type: 'page', page: 'plugin', pluginId: 'assistant', pluginPage: 'conversation' });
});

test('settings sections have direct URLs and round-trip through browser history', () => {
  const sections = ['personal', 'appearance', 'admin-catalog', 'admin-add-song', 'admin-accounts', 'admin-system'];
  for (const section of sections) {
    const route = { type: 'page', page: 'settings', section };
    assert.deepEqual(parsePathname(formatPath(route)), route);
  }
  const assistantConfiguration = { type: 'page', page: 'plugin', pluginId: 'assistant', pluginPage: 'configuration' };
  assert.deepEqual(parsePathname('/settings/admin/assistant'), assistantConfiguration);
  assert.deepEqual(parsePathname(formatPath({ type: 'page', page: 'settings', section: 'admin-assistant' })), assistantConfiguration);
  assert.deepEqual(parsePathname('/settings/admin'), { type: 'page', page: 'settings', section: 'admin-system' });
  assert.deepEqual(parsePathname('/settings/admin/instance'), { type: 'page', page: 'settings', section: 'admin-system' });
  assert.deepEqual(parsePathname('/settings/unknown'), { type: 'page', page: 'settings', section: 'appearance' });
  assert.equal(formatPath({ type: 'page', page: 'settings' }), '/settings/appearance');
});

test('legacy plugin workspaces canonicalize into the shared workspace and preserve detail identity', () => {
  for (const section of ['plugins', 'admin-plugins']) {
    for (const pluginSection of ['overview', 'connection', 'devices', 'playback']) {
      const route = { type: 'page', page: 'settings', section, pluginId: 'xiaomi-speaker', pluginSection };
      assert.deepEqual(parsePathname(formatPath(route)), { type: 'page', page: 'plugin', pluginId: route.pluginId, pluginPage: pluginSection });
    }
  }
  assert.deepEqual(parsePathname('/settings/plugins/xiaomi-speaker'), {
    type: 'page', page: 'plugin', pluginId: 'xiaomi-speaker', pluginPage: 'overview',
  });
  assert.equal(formatPath({ type: 'page', page: 'settings', section: 'admin-plugins', pluginId: 'future/plugin', pluginSection: 'a b' }),
    '/plugins/future%2Fplugin/a%20b');
  assert.deepEqual(parsePathname('/settings/plugins/future%2Fplugin/a%20b'), {
    type: 'page', page: 'plugin', pluginId: 'future/plugin', pluginPage: 'a b',
  });
  assert.deepEqual(parsePathname('/settings/plugins/xiaomi-speaker/overview/extra'),
    { type: 'page', page: 'settings', section: 'appearance' });
});

test('plugin list, management routes and legacy roots have one canonical URL without reserving plugin ids', () => {
  for (const section of ['list', 'delivery']) {
    const route = { type: 'page', page: 'plugin', section };
    assert.deepEqual(parsePathname(formatPath(route)), route);
  }
  assert.equal(formatPath({ type: 'page', page: 'settings', section: 'plugins' }), '/plugins');
  assert.equal(formatPath({ type: 'page', page: 'settings', section: 'admin-plugins' }), '/plugins');
  assert.deepEqual(parsePathname('/settings/plugins'), { type: 'page', page: 'plugin', section: 'list' });
  assert.deepEqual(parsePathname('/settings/admin/plugins'), { type: 'page', page: 'plugin', section: 'list' });
  assert.deepEqual(parsePathname('/plugins/_/install'), { type: 'page', page: 'plugin', section: 'list' });
  assert.deepEqual(parsePathname('/plugins/_/sources'), { type: 'page', page: 'plugin', section: 'delivery' });
  assert.deepEqual(parsePathname('/plugins/install'), { type: 'page', page: 'plugin', pluginId: 'install', pluginPage: 'overview' });
  assert.deepEqual(parsePathname('/plugins/_/missing'), { type: 'page', page: 'plugin', section: 'missing' });
});

test('catalog detail URLs retain the chosen source and version across reloads', () => {
  const route = { type: 'page', page: 'plugin', pluginId: 'external', pluginPage: 'overview', catalogSource: 'second-source', catalogVersion: '2.0.0' };
  const url = new URL(formatPath(route), 'https://flaretune.dev');
  assert.deepEqual(parseAppLocation(url), route);
});

test('assistant legacy conversation and memory URLs canonicalize to their plugin pages', () => {
  assert.deepEqual(parsePathname('/assistant/memory'),
    { type: 'page', page: 'plugin', pluginId: 'assistant', pluginPage: 'memory' });
  assert.equal(formatPath({ type: 'page', page: 'assistant', section: 'memory' }), '/plugins/assistant/memory');
  assert.equal(formatPath({ type: 'page', page: 'assistant', section: 'conversation' }), '/plugins/assistant/conversation');
});

test('service routes preserve plugin/page identity independently from settings compatibility URLs', () => {
  const route = { type: 'page', page: 'plugin', pluginId: 'reading-room', pluginPage: 'browse' };
  assert.equal(formatPath(route), '/plugins/reading-room/browse');
  assert.deepEqual(parsePathname(formatPath(route)), route);
  assert.deepEqual(parsePathname('/plugins/reading-room'), { ...route, pluginPage: 'overview' });
  assert.deepEqual(parsePathname('/plugins/reading-room/browse/extra'), { type: 'page', page: 'home' });
  assert.deepEqual(parsePathname('/plugins/reading%2Froom/page%20name'), { ...route, pluginId: 'reading/room', pluginPage: 'page name' });
});

test('roam browse has one host route while its plugin overview remains in plugin management', () => {
  const route = { type: 'page', page: 'roam' };
  for (const url of ['/roam', '/roam?lang=zh#top', '/plugins/roam/browse', '/plugins/roam/browse?source=official#top']) {
    assert.deepEqual(parsePathname(url), route);
    assert.equal(formatPath(parsePathname(url)), '/roam');
  }
  assert.equal(formatPath({ type: 'page', page: 'plugin', pluginId: 'roam', pluginPage: 'browse' }), '/roam');
  assert.deepEqual(parsePathname('/plugins/roam/overview'), { type: 'page', page: 'plugin', pluginId: 'roam', pluginPage: 'overview' });
});

function browserHistory(start, inspect) {
  const previousWindow = globalThis.window, previousCustomEvent = globalThis.CustomEvent;
  const location = { pathname: '', search: '' }, entries = [{ url: start, state: null }], moves = [];
  let index = 0;
  const setLocation = url => { const parsed = new URL(url, 'https://test.example'); location.pathname = parsed.pathname; location.search = parsed.search; };
  setLocation(start);
  const history = {
    state: null, get length() { return entries.length; },
    replaceState(state, _title, url) { const target = url || entries[index].url; entries[index] = { url: target, state }; this.state = state; setLocation(target); },
    pushState(state, _title, url) { entries.splice(index + 1, entries.length, { url, state }); index++; this.state = state; setLocation(url); },
    go(delta) { moves.push(delta); index += delta; assert.ok(index >= 0 && index < entries.length); this.state = entries[index].state; setLocation(entries[index].url); },
    back() { this.go(-1); },
  };
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  globalThis.window = { location, history, dispatchEvent() {} };
  try { inspect({ location, history, moves, entries }); }
  finally { globalThis.window = previousWindow; globalThis.CustomEvent = previousCustomEvent; }
}

test('daily plugin service return preserves home, plugin list or management origin through internal tab changes', () => {
  for (const origin of ['/home', '/plugins', '/plugins/assistant/overview']) browserHistory('/home', ({ history, location, moves }) => {
    if (origin !== '/home') syncBrowserHistory(origin);
    syncBrowserHistory('/plugins/assistant/conversation');
    syncBrowserHistory('/plugins/assistant/memory');
    syncBrowserHistory('/plugins/assistant/conversation');
    assert.equal(history.state.sidebarOrigin, origin);
    assert.equal(history.state.sidebarDepth, 3);
    assert.equal(returnFromSidebarWorkspace('/home'), 'back');
    assert.deepEqual(moves, [-3]);
    assert.equal(location.pathname + location.search, origin);
  });
});

test('direct service links followed by internal tabs return home without looping between tabs', () => {
  browserHistory('/plugins/assistant/memory', ({ history, location, moves }) => {
    syncBrowserHistory('/plugins/assistant/conversation');
    syncBrowserHistory('/plugins/assistant/memory');
    assert.equal(history.state.sidebarOrigin, null);
    assert.equal(returnFromSidebarWorkspace('/home'), 'replace');
    assert.equal(location.pathname, '/home'); assert.deepEqual(moves, []);
  });
});

test('a direct category page returns to host roam without requiring the roam plugin', () => {
  browserHistory('/explore/zh', ({ location, moves }) => {
    assert.equal(returnToOriginRoute('/roam'), 'replace');
    assert.equal(location.pathname, '/roam'); assert.deepEqual(moves, []);
  });
});

test('lyrics workbench song and sidebar sections have direct URLs', () => {
  for (const section of ['current', 'tools', 'candidates']) {
    const route = { type: 'page', page: 'lyrics', songId: 'song 你好', section };
    const pluginRoute = { type: 'page', page: 'plugin', pluginId: 'lyrics-workbench', songId: route.songId, pluginPage: section };
    assert.deepEqual(parsePathname(formatPath(route)), pluginRoute);
    assert.deepEqual(parseAppLocation(new URL(formatPath(route), 'https://flare.test')), pluginRoute);
    assert.deepEqual(parsePathname(`/lyrics/${encodeURIComponent(route.songId)}/${section}`), pluginRoute);
  }
  assert.deepEqual(parsePathname('/lyrics/song-id/unknown'),
    { type: 'page', page: 'plugin', pluginId: 'lyrics-workbench', songId: 'song-id', pluginPage: 'current' });
});

test('parsePathname strips query params and hash correctly', () => {
  assert.deepEqual(parsePathname('/search?q=test#top'), { type: 'page', page: 'search' });
  assert.deepEqual(parsePathname('/roam?lang=zh'), { type: 'page', page: 'roam' });
});

test('parsePathname resolves artist routes with percent-encoded or plain names', () => {
  assert.deepEqual(parsePathname('/artist/Jay%20Chou'), { type: 'artist', name: 'Jay Chou', view: 'overview' });
  assert.deepEqual(parsePathname('/artist/周杰伦'), { type: 'artist', name: '周杰伦', view: 'overview' });
  assert.deepEqual(parsePathname('/artist/%E5%91%A8%E6%9D%B0%E4%BC%A6'), { type: 'artist', name: '周杰伦', view: 'overview' });
  assert.deepEqual(parsePathname('/artist/周杰伦/songs'), { type: 'artist', name: '周杰伦', view: 'songs' });
  assert.deepEqual(parsePathname('/artist/周杰伦/albums'), { type: 'artist', name: '周杰伦', view: 'albums' });
});

test('parsePathname resolves playlist routes', () => {
  assert.deepEqual(parsePathname('/playlist/daily'), { type: 'playlist', id: 'daily' });
  assert.deepEqual(parsePathname('/playlist/user-favorites-1'), { type: 'playlist', id: 'user-favorites-1' });
});

test('parsePathname falls back to home on unrecognized paths', () => {
  assert.deepEqual(parsePathname('/nonexistent-page'), { type: 'page', page: DEFAULT_PAGE });
});

test('formatPath produces clean canonical URL strings', () => {
  assert.equal(formatPath({ type: 'page', page: 'home' }), '/home');
  assert.equal(formatPath({ type: 'page', page: 'search' }), '/search');
  assert.equal(formatPath({ type: 'artist', name: '周杰伦' }), '/artist/%E5%91%A8%E6%9D%B0%E4%BC%A6');
  assert.equal(formatPath({ type: 'artist', name: '周杰伦', view: 'songs' }), '/artist/%E5%91%A8%E6%9D%B0%E4%BC%A6/songs');
  assert.equal(formatPath({ type: 'artist', name: '周杰伦', view: 'albums' }), '/artist/%E5%91%A8%E6%9D%B0%E4%BC%A6/albums');
  assert.equal(formatPath({ type: 'playlist', id: 'daily' }), '/playlist/daily');
  assert.equal(formatPath(null), '/home');
});

test('music browser routes round-trip through direct URLs', () => {
  const routes = [
    { type: 'album', id: 'YWJjXzEyMw' },
    { type: 'explore', language: 'zh', view: 'overview' },
    { type: 'explore', language: 'ja', view: 'songs' },
    { type: 'explore', language: 'en', view: 'artists' },
    { type: 'top-songs' },
    { type: 'top-artists' },
  ];
  for (const route of routes) assert.deepEqual(parsePathname(formatPath(route)), route);
  assert.deepEqual(parsePathname('/library/top-albums'), { type: 'page', page: 'library' });
  assert.deepEqual(parseAppLocation({ pathname: '/search', search: '?q=caixukun&type=albums&lang=zh' }),
    { type: 'page', page: 'search', query: 'caixukun', view: 'albums', language: 'zh' });
  assert.equal(formatPath({ type: 'page', page: 'search', query: '周杰伦', view: 'songs', language: 'zh' }),
    '/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6&type=songs&lang=zh');
});

test('returnToParentRoute goes back to an actual parent entry and preserves its scroll history', () => {
  const previousWindow = globalThis.window;
  let backCalls = 0;
  globalThis.window = {
    location: { pathname: '/artist/Jay/songs', search: '' },
    history: {
      state: { url: '/artist/Jay/songs', from: '/artist/Jay' },
      length: 3,
      back: () => { backCalls += 1; },
    },
  };
  try {
    assert.equal(returnToParentRoute('/artist/Jay'), 'back');
    assert.equal(backCalls, 1);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('album return follows the route that opened it, including search and artist subpages', () => {
  const previousWindow = globalThis.window;
  const origins = [
    '/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6&type=albums',
    '/artist/%E5%91%A8%E6%9D%B0%E4%BC%A6/albums',
    '/explore/zh/albums',
    '/library/top-albums',
  ];
  try {
    for (const from of origins) {
      let backCalls = 0;
      globalThis.window = {
        location: { pathname: '/album/example', search: '' },
        history: {
          state: { url: '/album/example', from },
          length: 3,
          back: () => { backCalls += 1; },
        },
      };
      assert.equal(returnToOriginRoute('/library'), 'back', from);
      assert.equal(backCalls, 1, from);
    }
  } finally {
    globalThis.window = previousWindow;
  }
});

test('direct album URL returns to the library without following an unrelated history entry', () => {
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  const location = { pathname: '/album/example', search: '' };
  let backCalls = 0;
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  globalThis.window = {
    location,
    history: {
      state: { url: '/album/example', from: 'https://elsewhere.example' },
      length: 2,
      back: () => { backCalls += 1; },
      replaceState(state, _title, url) { this.state = state; location.pathname = url; },
    },
    dispatchEvent: () => {},
  };
  try {
    assert.equal(returnToOriginRoute('/library'), 'replace');
    assert.equal(location.pathname, '/library');
    assert.equal(backCalls, 0);
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }
});

test('direct child URLs replace themselves with their parent and retain entry metadata', () => {
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  const events = [];
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  const location = { pathname: '/explore/zh/songs', search: '' };
  const history = {
    state: null,
    length: 1,
    replaceState(state, _title, url) { this.state = state; location.pathname = url; },
  };
  globalThis.window = { location, history, dispatchEvent: (event) => events.push(event) };
  try {
    assert.equal(returnToParentRoute('/explore/zh'), 'replace');
    assert.equal(location.pathname, '/explore/zh');
    assert.equal(history.state.url, '/explore/zh');
    assert.ok(history.state.scrollEntryId);
    assert.equal(events[0].detail.replace, true);
    const firstEntryId = history.state.scrollEntryId;
    syncBrowserHistory('/explore/zh?lang=zh', { replace: true });
    assert.equal(history.state.url, '/explore/zh?lang=zh');
    assert.notEqual(history.state.scrollEntryId, firstEntryId);
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }
});

test('sidebar return goes to the page that opened the workspace after internal section changes', () => {
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  try {
    for (const [origin, workspace, section] of [
      ['/home', '/assistant', '/assistant/memory'],
      ['/search?q=jazz', '/settings/appearance', '/settings/admin/system'],
      ['/search?q=plugins', '/settings/appearance', '/plugins'],
      ['/explore/zh', '/settings/appearance', '/plugins/_/sources'],
      ['/search?q=devices', '/plugins', '/plugins/xiaomi-speaker/connection'],
      ['/search?q=books', '/plugins/reading-room/browse', '/plugins/reading-room/notes'],
    ]) {
      const location = { pathname: origin.split('?')[0], search: origin.includes('?') ? `?${origin.split('?')[1]}` : '' };
      const entries = [{ url: origin, state: null }];
      const moves = [];
      const setLocation = (url) => {
        const [pathname, query] = url.split('?');
        location.pathname = pathname;
        location.search = query ? `?${query}` : '';
      };
      const history = {
        state: null,
        get length() { return entries.length; },
        replaceState(state, _title, url) {
          const destination = url || entries[entries.length - 1].url;
          entries[entries.length - 1] = { url: destination, state };
          this.state = state;
          setLocation(destination);
        },
        pushState(state, _title, url) {
          entries.push({ url, state });
          this.state = state;
          setLocation(url);
        },
        go(delta) {
          moves.push(delta);
          const entry = entries[entries.length - 1 + delta];
          this.state = entry.state;
          setLocation(entry.url);
        },
      };
      globalThis.window = { location, history, dispatchEvent: () => {} };
      syncBrowserHistory(workspace);
      syncBrowserHistory(section);
      assert.equal(history.state.sidebarOrigin, origin);
      assert.equal(history.state.sidebarDepth, 2);
      assert.equal(returnFromSidebarWorkspace('/home'), 'back');
      assert.deepEqual(moves, [-2]);
      assert.equal(location.pathname + location.search, origin);
    }
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }
});

test('rejected lyrics Back restores sidebar origin so its return reaches search', () => {
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  const location = { pathname: '/search', search: '?q=jazz' };
  const entries = [{ url: '/search?q=jazz', state: null }];
  let index = 0;
  const setLocation = (url) => {
    const [pathname, query] = url.split('?');
    location.pathname = pathname;
    location.search = query ? `?${query}` : '';
  };
  const history = {
    state: null,
    get length() { return entries.length; },
    replaceState(state, _title, url) {
      const destination = url || entries[index].url;
      entries[index] = { url: destination, state };
      this.state = state;
      setLocation(destination);
    },
    pushState(state, _title, url) {
      entries.splice(index + 1, entries.length - index - 1, { url, state });
      index += 1;
      this.state = state;
      setLocation(url);
    },
    go(delta) {
      index += delta;
      this.state = entries[index].state;
      setLocation(entries[index].url);
    },
  };
  globalThis.window = { location, history, dispatchEvent: () => {} };
  try {
    syncBrowserHistory('/lyrics/song-1');
    const lyricsScrollEntry = history.state.scrollEntryId;
    history.go(-1); // Browser Back arrives on search before the guard rejects it.
    restoreSidebarWorkspaceAfterRejectedBack('/lyrics/song-1', lyricsScrollEntry);
    assert.equal(history.state.sidebarPage, 'plugin:lyrics-workbench:lyrics');
    assert.equal(history.state.sidebarOrigin, '/search?q=jazz');
    assert.equal(history.state.sidebarDepth, 1);
    assert.equal(history.state.scrollEntryId, lyricsScrollEntry);
    assert.equal(returnFromSidebarWorkspace('/home'), 'back');
    assert.equal(location.pathname + location.search, '/search?q=jazz');
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }
});

test('direct workspace links return to home without following unrelated browser history', () => {
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  const location = { pathname: '/assistant/memory', search: '' };
  let backCalls = 0;
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  globalThis.window = {
    location,
    history: {
      state: null,
      length: 3,
      go: () => { backCalls += 1; },
      replaceState(state, _title, url) { this.state = state; if (url) location.pathname = url; },
    },
    dispatchEvent: () => {},
  };
  try {
    assert.equal(returnFromSidebarWorkspace('/home'), 'replace');
    assert.equal(location.pathname, '/home');
    assert.equal(backCalls, 0);
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }
});

test('each visit to the same route gets a separate scroll position key', () => {
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  const location = { pathname: '/home', search: '' };
  const entries = [{ url: '/home', state: null }];
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  globalThis.window = {
    location,
    history: {
      state: null,
      replaceState(state, _title, url) {
        this.state = state;
        entries[entries.length - 1] = { url: url || location.pathname, state };
        if (url) location.pathname = url;
      },
      pushState(state, _title, url) {
        this.state = state;
        entries.push({ url, state });
        location.pathname = url;
      },
    },
    dispatchEvent: () => {},
  };
  try {
    syncBrowserHistory('/library/top-albums');
    syncBrowserHistory('/home');
    assert.equal(entries[0].url, '/home');
    assert.equal(entries[2].url, '/home');
    assert.notEqual(entries[0].state.scrollEntryId, entries[2].state.scrollEntryId);
    assert.equal(entries[2].state.from, '/library/top-albums');
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }
});
