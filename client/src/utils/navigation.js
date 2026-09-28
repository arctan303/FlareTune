/**
 * FlareTune 前端轻量路由与导航工具
 * 规范化 URL 路径，支持浏览器前进/后退与深层链接 (Deep Linking)
 */

export const SUPPORTED_PAGES = ['home', 'history', 'search', 'roam', 'library', 'settings', 'assistant', 'lyrics'];
export const DEFAULT_PAGE = 'home';
const SETTINGS_PATHS = Object.freeze({
  personal: '/settings/personal',
  appearance: '/settings/appearance',
  'admin-assistant': '/settings/admin/assistant',
  'admin-catalog': '/settings/admin/catalog',
  'admin-add-song': '/settings/admin/catalog/new',
  'admin-accounts': '/settings/admin/accounts',
  'admin-system': '/settings/admin/system',
});
const RESULT_TYPES = new Set(['songs', 'artists', 'albums']);
const EXPLORE_TYPES = new Set(['songs', 'artists', 'albums']);
const EXPLORE_LANGUAGES = new Set(['zh', 'en', 'instrumental', 'ja', 'other', 'ko']);
const LYRICS_SECTIONS = new Set(['current', 'tools', 'candidates']);
const SIDEBAR_WORKSPACES = new Set(['settings', 'assistant', 'lyrics']);

/**
 * 将当前路径解析为结构化路由对象
 * @param {string} pathname 
 * @returns {{ type: 'page' | 'artist' | 'playlist', page?: string, name?: string, id?: string }}
 */
export function parsePathname(pathname = '') {
  const cleanPath = (pathname || '').split('?')[0].split('#')[0];
  const segments = cleanPath.split('/').filter(Boolean);

  if (segments.length === 0) {
    return { type: 'page', page: DEFAULT_PAGE };
  }

  const [firstSegment, ...rest] = segments;

  if (firstSegment === 'settings') {
    if (segments.length === 1) return { type: 'page', page: 'settings', section: 'appearance' };
    if (segments.length === 2 && segments[1] === 'admin') return { type: 'page', page: 'settings', section: 'admin-system' };
    if (segments.length === 3 && segments[1] === 'admin' && segments[2] === 'instance') {
      return { type: 'page', page: 'settings', section: 'admin-system' };
    }
    const section = Object.keys(SETTINGS_PATHS).find((key) => SETTINGS_PATHS[key] === `/${segments.join('/')}`);
    return { type: 'page', page: 'settings', section: section || 'appearance' };
  }

  if (firstSegment === 'assistant' && rest[0] === 'memory' && rest.length === 1) {
    return { type: 'page', page: 'assistant', section: 'memory' };
  }

  if (firstSegment === 'lyrics' && rest[0]) {
    return { type: 'page', page: 'lyrics', songId: decodeSegment(rest[0]),
      section: LYRICS_SECTIONS.has(rest[1]) ? rest[1] : 'current' };
  }

  if (firstSegment === 'album' && rest.length === 1) {
    return { type: 'album', id: decodeSegment(rest[0]) };
  }

  if (firstSegment === 'explore' && EXPLORE_LANGUAGES.has(rest[0]) && rest.length <= 2) {
    return { type: 'explore', language: rest[0], view: EXPLORE_TYPES.has(rest[1]) ? rest[1] : 'overview' };
  }

  if (firstSegment === 'library' && rest.length === 1 && rest[0] === 'top-songs') {
    return { type: 'top-songs' };
  }

  if (firstSegment === 'library' && rest.length === 1 && rest[0] === 'top-albums') {
    return { type: 'page', page: 'library' };
  }

  if (firstSegment === 'library' && rest.length === 1 && rest[0] === 'top-artists') {
    return { type: 'top-artists' };
  }

  // 1. 歌手路由: /artist/:name, /artist/:name/songs, /artist/:name/albums
  if (firstSegment === 'artist' && rest.length > 0) {
    const rawSubView = rest[rest.length - 1];
    let view = 'overview';
    let nameSegments = rest;

    if (['songs', 'albums'].includes(rawSubView) && rest.length >= 2) {
      view = rawSubView;
      nameSegments = rest.slice(0, rest.length - 1);
    }

    const rawName = nameSegments.join('/');
    try {
      return { type: 'artist', name: decodeURIComponent(rawName), view };
    } catch {
      return { type: 'artist', name: rawName, view };
    }
  }

  // 2. 歌单路由: /playlist/:id
  if (firstSegment === 'playlist' && rest.length > 0) {
    const rawId = rest.join('/');
    try {
      return { type: 'playlist', id: decodeURIComponent(rawId) };
    } catch {
      return { type: 'playlist', id: rawId };
    }
  }

  // 3. 一级主页面: /home, /search, /roam, /library, /settings, /assistant
  if (firstSegment === 'xiaoa') {
    return { type: 'page', page: 'assistant' };
  }
  if (SUPPORTED_PAGES.includes(firstSegment)) {
    return { type: 'page', page: firstSegment };
  }

  // 兜底返回默认首页
  return { type: 'page', page: DEFAULT_PAGE };
}

function decodeSegment(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function parseAppLocation(location = {}) {
  const route = parsePathname(location.pathname || '/');
  if (route.type !== 'page' || route.page !== 'search') return route;
  const params = new URLSearchParams(location.search || '');
  return {
    ...route,
    query: (params.get('q') || '').trim(),
    view: RESULT_TYPES.has(params.get('type')) ? params.get('type') : 'overview',
    language: EXPLORE_LANGUAGES.has(params.get('lang')) ? params.get('lang') : 'all',
  };
}

/**
 * 将路由对象格式化为标准 URL Path
 * @param {{ type: string, page?: string, name?: string, id?: string, view?: string }} route
 * @returns {string}
 */
export function formatPath(route) {
  if (!route) return `/${DEFAULT_PAGE}`;

  if (route.type === 'page' && route.page === 'settings') {
    return SETTINGS_PATHS[route.section] || SETTINGS_PATHS.appearance;
  }
  if (route.type === 'page' && route.page === 'assistant') {
    return route.section === 'memory' ? '/assistant/memory' : '/assistant';
  }

  if (route.type === 'page' && route.page === 'lyrics' && route.songId) {
    const base = `/lyrics/${encodeURIComponent(route.songId)}`;
    return route.section && route.section !== 'current' && LYRICS_SECTIONS.has(route.section)
      ? `${base}/${route.section}` : base;
  }

  if (route.type === 'artist' && route.name) {
    const encoded = encodeURIComponent(route.name);
    if (route.view === 'songs') return `/artist/${encoded}/songs`;
    if (route.view === 'albums') return `/artist/${encoded}/albums`;
    return `/artist/${encoded}`;
  }

  if (route.type === 'playlist' && route.id) {
    return `/playlist/${encodeURIComponent(route.id)}`;
  }

  if (route.type === 'album' && route.id) return `/album/${encodeURIComponent(route.id)}`;
  if (route.type === 'top-songs') return '/library/top-songs';
  if (route.type === 'top-artists') return '/library/top-artists';
  if (route.type === 'explore' && EXPLORE_LANGUAGES.has(route.language)) {
    const base = `/explore/${route.language}`;
    return EXPLORE_TYPES.has(route.view) ? `${base}/${route.view}` : base;
  }

  if (route.type === 'page' && route.page === 'search') {
    const params = new URLSearchParams();
    if (route.query?.trim()) params.set('q', route.query.trim());
    if (route.query?.trim() && RESULT_TYPES.has(route.view)) params.set('type', route.view);
    if (route.language && route.language !== 'all' && EXPLORE_LANGUAGES.has(route.language)) params.set('lang', route.language);
    return `/search${params.size ? `?${params.toString()}` : ''}`;
  }

  if (route.type === 'page' && route.page) {
    return `/${route.page}`;
  }

  return `/${DEFAULT_PAGE}`;
}

/**
 * 安全地同步浏览器历史记录
 * @param {string} url 
 * @param {{ replace?: boolean, state?: any }} options 
 */
let scrollEntrySequence = 0;

export function ensureHistoryScrollEntry() {
  if (typeof window === 'undefined' || !window.history) return '';
  if (window.history.state?.scrollEntryId) return window.history.state.scrollEntryId;
  const scrollEntryId = `${Date.now()}-${++scrollEntrySequence}`;
  window.history.replaceState({ ...window.history.state, scrollEntryId }, '');
  return scrollEntryId;
}

export function syncBrowserHistory(url, { replace = false, state = {} } = {}) {
  if (typeof window === 'undefined' || !window.history) return;

  const currentPath = window.location.pathname + window.location.search;
  if (currentPath === url) return;

  const targetPage = parsePathname(url).page;
  const currentPage = parsePathname(currentPath).page;
  let sidebarState = {};
  if (SIDEBAR_WORKSPACES.has(targetPage)) {
    const previous = window.history.state;
    if (currentPage === targetPage) {
      const origin = previous?.sidebarPage === targetPage ? previous.sidebarOrigin : null;
      const depth = origin ? Number(previous.sidebarDepth) || 0 : 0;
      sidebarState = { sidebarPage: targetPage, sidebarOrigin: origin,
        sidebarDepth: origin ? depth + (replace ? 0 : 1) : 0 };
    } else {
      sidebarState = { sidebarPage: targetPage, sidebarOrigin: currentPath,
        sidebarDepth: replace ? 0 : 1 };
    }
  }

  ensureHistoryScrollEntry();
  const scrollEntryId = `${Date.now()}-${++scrollEntrySequence}`;

  if (replace) {
    window.history.replaceState({ ...window.history.state, ...state, ...sidebarState, url, scrollEntryId }, '', url);
  } else {
    window.history.pushState({ ...state, ...sidebarState, from: currentPath, url, scrollEntryId }, '', url);
  }
  window.dispatchEvent(new CustomEvent('flaretune:navigate', { detail: { url, replace } }));
}

export function returnFromSidebarWorkspace(fallbackUrl = '/home') {
  if (typeof window === 'undefined' || !window.history) return;
  const currentPath = window.location.pathname + window.location.search;
  const state = window.history.state;
  const origin = state?.sidebarOrigin;
  const depth = Number(state?.sidebarDepth);
  const validOrigin = state?.url === currentPath
    && state?.sidebarPage === parsePathname(currentPath).page
    && typeof origin === 'string' && origin.startsWith('/') && !origin.startsWith('//')
    && origin !== currentPath;
  if (validOrigin && Number.isInteger(depth) && depth > 0
    && window.history.length > depth && typeof window.history.go === 'function') {
    window.history.go(-depth);
    return 'back';
  }
  return returnToParentRoute(validOrigin ? origin : fallbackUrl);
}

// A guarded browser Back has already moved onto the previous entry. Recreate
// the workspace as one entry above that page so its sidebar return still lands
// on the page the user just attempted to leave for.
export function restoreSidebarWorkspaceAfterRejectedBack(url, scrollEntryId) {
  if (typeof window === 'undefined' || !window.history) return null;
  const sidebarPage = parsePathname(url).page;
  const from = window.location.pathname + window.location.search;
  if (!SIDEBAR_WORKSPACES.has(sidebarPage) || from === url) return null;
  const state = {
    url,
    from,
    sidebarPage,
    sidebarOrigin: from,
    sidebarDepth: 1,
    scrollEntryId: scrollEntryId || `${Date.now()}-${++scrollEntrySequence}`,
  };
  window.history.pushState(state, '', url);
  return state;
}

export function returnToParentRoute(parentUrl) {
  if (typeof window === 'undefined' || !window.history) return;
  const currentPath = window.location.pathname + window.location.search;
  if (window.history.state?.url === currentPath
    && window.history.state?.from === parentUrl
    && window.history.length > 1) {
    window.history.back();
    return 'back';
  }
  syncBrowserHistory(parentUrl, { replace: true });
  return 'replace';
}

export function returnToOriginRoute(fallbackUrl) {
  if (typeof window === 'undefined' || !window.history) return;
  const currentPath = window.location.pathname + window.location.search;
  const { url, from } = window.history.state || {};
  const hasInternalOrigin = url === currentPath
    && typeof from === 'string'
    && from.startsWith('/')
    && !from.startsWith('//')
    && from !== currentPath
    && window.history.length > 1;
  return returnToParentRoute(hasInternalOrigin ? from : fallbackUrl);
}
