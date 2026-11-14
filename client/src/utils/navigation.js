/**
 * FlareTune 前端轻量路由与导航工具
 * 规范化 URL 路径，支持浏览器前进/后退与深层链接 (Deep Linking)
 */

import { approvePluginNavigation } from '../plugins/leaveGuard.js';
import { compiledPluginManifests } from '../../../shared/plugins/catalog.js';
export const SUPPORTED_PAGES = ['home', 'history', 'search', 'roam', 'library', 'settings', 'assistant', 'lyrics', 'plugin'];
export const DEFAULT_PAGE = 'home';
const SETTINGS_PATHS = Object.freeze({
  personal: '/settings/personal',
  appearance: '/settings/appearance',
  plugins: '/settings/plugins',
  'admin-plugins': '/settings/admin/plugins',
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
const SIDEBAR_WORKSPACES = new Set(['settings', 'assistant', 'lyrics', 'plugin']);
// Service tabs share their entry origin; administration keeps the settings scope.
const sidebarWorkspace = route => {
  if (route?.page !== 'plugin') return route?.page;
  if (!route.pluginId || !route.pluginPage || route.pluginPage === 'overview') return 'settings';
  const page = compiledPluginManifests.find(plugin => plugin.id === route.pluginId)?.pages
    .find(page => page.id === route.pluginPage);
  return page?.kind === 'settings' ? 'settings' : `plugin:${route.pluginId}:${page?.group || 'service'}`;
};
const isSidebarWorkspace = scope => SIDEBAR_WORKSPACES.has(scope) || scope?.startsWith('plugin:');
export const isLyricsWorkspaceRoute = route => route?.page === 'lyrics' || (route?.page === 'plugin' && route.pluginId === 'lyrics-workbench' && LYRICS_SECTIONS.has(route.pluginPage));

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

  if (firstSegment === 'roam' && rest.length === 0) return { type: 'page', page: 'roam' };

  if (firstSegment === 'plugins') {
    if (rest.length === 0) return { type: 'page', page: 'plugin', section: 'list' };
    // '_' cannot be a plugin id, so workspace routes never reserve an author's id.
    if (rest[0] === '_' && rest.length === 2 && ['install', 'sources', 'delivery'].includes(rest[1])) {
      return { type: 'page', page: 'plugin', section: rest[1] === 'install' ? 'list' : 'delivery' };
    }
    if (rest[0] !== '_' && rest.length >= 1 && rest.length <= 2) {
      if (decodeSegment(rest[0]) === 'roam' && decodeSegment(rest[1]) === 'browse') return { type: 'page', page: 'roam' };
      const songId = new URLSearchParams((pathname.split('?')[1] || '').split('#')[0]).get('song');
      return { type: 'page', page: 'plugin', pluginId: decodeSegment(rest[0]), pluginPage: decodeSegment(rest[1] || 'overview'),
        ...(rest[0] === 'lyrics-workbench' && songId ? { songId } : {}) };
    }
    return rest[0] === '_' ? { type: 'page', page: 'plugin', section: 'missing' } : { type: 'page', page: DEFAULT_PAGE };
  }

  if (firstSegment === 'settings') {
    if (segments.length === 1) return { type: 'page', page: 'settings', section: 'appearance' };
    if (segments.length === 2 && segments[1] === 'admin') return { type: 'page', page: 'settings', section: 'admin-system' };
    if (segments.length === 3 && segments[1] === 'admin' && segments[2] === 'instance') {
      return { type: 'page', page: 'settings', section: 'admin-system' };
    }
    const pluginOffset = segments[1] === 'admin' ? 3 : 2;
    if (segments[pluginOffset - 1] === 'plugins' && segments.length > pluginOffset && segments.length <= pluginOffset + 2) {
      return { type: 'page', page: 'plugin', pluginId: decodeSegment(segments[pluginOffset]),
        pluginPage: decodeSegment(segments[pluginOffset + 1] || 'overview') };
    }
    const section = Object.keys(SETTINGS_PATHS).find((key) => SETTINGS_PATHS[key] === `/${segments.join('/')}`);
    if (section === 'admin-assistant') return { type: 'page', page: 'plugin', pluginId: 'assistant', pluginPage: 'configuration' };
    if (section === 'plugins' || section === 'admin-plugins') {
      return { type: 'page', page: 'plugin', section: 'list' };
    }
    return { type: 'page', page: 'settings', section: section || 'appearance' };
  }

  if (['assistant', 'xiaoa'].includes(firstSegment) && (rest.length === 0 || (rest.length === 1 && rest[0] === 'memory'))) {
    return { type: 'page', page: 'plugin', pluginId: 'assistant', pluginPage: rest[0] === 'memory' ? 'memory' : 'conversation' };
  }

  if (firstSegment === 'lyrics' && rest[0]) {
    return { type: 'page', page: 'plugin', pluginId: 'lyrics-workbench', songId: decodeSegment(rest[0]),
      pluginPage: LYRICS_SECTIONS.has(rest[1]) ? rest[1] : 'current' };
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
    const name = decodeSegment(rawName);
    return { type: 'artist', name, view,
      ...(name.startsWith('yt:artist:') ? { id: name, source: 'youtube' } : {}) };
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
  const params = new URLSearchParams(location.search || '');
  if (route.page === 'plugin' && route.pluginId === 'lyrics-workbench' && params.get('song')) return { ...route, songId: params.get('song') };
  if (route.type === 'page' && route.page === 'plugin' && route.pluginId && route.pluginPage === 'overview') {
    const source = params.get('source'), version = params.get('version');
    return source && version ? { ...route, catalogSource: source, catalogVersion: version } : route;
  }
  if (route.type !== 'page' || route.page !== 'search') return route;
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
  if (route.type === 'page' && (route.page === 'roam'
    || route.page === 'plugin' && route.pluginId === 'roam' && route.pluginPage === 'browse')) return '/roam';

  if (route.type === 'page' && route.page === 'plugin' && route.pluginId) {
    const params = new URLSearchParams();
    if (route.pluginId === 'lyrics-workbench' && route.songId) params.set('song', String(route.songId));
    if ((!route.pluginPage || route.pluginPage === 'overview') && route.catalogSource && route.catalogVersion) {
      params.set('source', route.catalogSource); params.set('version', route.catalogVersion);
    }
    return `/plugins/${encodeURIComponent(route.pluginId)}/${encodeURIComponent(route.pluginPage || 'overview')}${params.size ? '?' + params : ''}`;
  }

  if (route.type === 'page' && route.page === 'plugin') {
    return ['sources', 'delivery'].includes(route.section) ? '/plugins/_/delivery' : '/plugins';
  }

  if (route.type === 'page' && route.page === 'settings') {
    if (route.section === 'admin-assistant') return '/plugins/assistant/configuration';
    if (['plugins', 'admin-plugins'].includes(route.section) && route.pluginId) {
      return formatPath({ type: 'page', page: 'plugin', pluginId: route.pluginId, pluginPage: route.pluginSection || 'overview' });
    }
    if (['plugins', 'admin-plugins'].includes(route.section)) return '/plugins';
    return SETTINGS_PATHS[route.section] || SETTINGS_PATHS.appearance;
  }
  if (route.type === 'page' && route.page === 'assistant') {
    return `/plugins/assistant/${route.section === 'memory' ? 'memory' : 'conversation'}`;
  }

  if (route.type === 'page' && route.page === 'lyrics' && route.songId) {
    return formatPath({ type: 'page', page: 'plugin', pluginId: 'lyrics-workbench', pluginPage: LYRICS_SECTIONS.has(route.section) ? route.section : 'current', songId: route.songId });
  }

  if (route.type === 'artist' && route.name) {
    const encoded = encodeURIComponent(route.id?.startsWith('yt:artist:') ? route.id : route.name);
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
  if (!approvePluginNavigation(url)) return;

  const targetPage = sidebarWorkspace(parsePathname(url));
  const currentPage = sidebarWorkspace(parsePathname(currentPath));
  let sidebarState = {};
  if (isSidebarWorkspace(targetPage)) {
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
    && state?.sidebarPage === sidebarWorkspace(parsePathname(currentPath))
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
  const sidebarPage = sidebarWorkspace(parsePathname(url));
  const from = window.location.pathname + window.location.search;
  if (!isSidebarWorkspace(sidebarPage) || from === url) return null;
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
