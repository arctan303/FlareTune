import { useUIStore, showToast } from '../store/useUIStore.js';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { usePluginStore } from '../store/usePluginStore.js';
import { instanceRequest } from '../instance/api.js';
import { runtimeFetch, isDemoRuntime } from '../services/runtimeFetch.js';
import { fetchSongById } from '../services/songApi.js';
import { repairSongLanguages, songHasValidLanguage } from '../resolveSongs.js';
import { getApiBaseUrl } from '../services/apiBase.js';
import { formatPath, syncBrowserHistory, returnToOriginRoute, parsePathname } from '../utils/navigation.js';
import { registerPluginLeaveGuard } from './leaveGuard.js';
import { createPluginTransport, pluginEndpoint } from './transport.js';
import { dispatchScopedPlayerAction } from './playerActions.js';
import { capturePlaybackCleanup } from './playbackCleanup.js';
import { createOutputCapability } from './outputCapability.js';
import { registerPluginContribution } from './contributions.js';
import { pluginBuilds } from '../../../shared/plugins/build.generated.js';
import { createPluginMusicSources } from './musicSources.js';
import { canAccessPluginDeclaration, isPluginVisibleToRole } from '../../../shared/plugins/manifest.js';
import { EXPLORE_CATEGORIES } from '../constants/explore.js';
import { hydrateSong, hydratePlayableSong } from '../utils.js';
import { invalidateLyricsCacheForSong } from '../hooks/useLyricsFetcher.js';

const identity = session => session?.authenticated
  ? JSON.stringify([session.user?.accountId, session.user?.role, session.csrfToken]) : '';
const retired = () => new DOMException('Plugin session ended', 'AbortError');

// This facade is the public boundary for trusted, compiled plugins. It does not
// expose mutable host stores. Backend authorization remains authoritative.
export function createPluginHost(plugin, options = {}) {
  const sessionStore = options.sessionStore || useUIStore;
  const playerStore = options.playerStore || usePlayerStore;
  const pluginStore = options.pluginStore || usePluginStore;
  const navigate = options.navigate || (route => syncBrowserHistory(formatPath(route)));
  const session = sessionStore.getState().authSession;
  const owner = identity(session);
  const publicSession = Object.freeze({ authenticated: Boolean(session?.authenticated),
    user: session?.user ? Object.freeze({ ...session.user }) : null });
  const isLocalDev = typeof location !== 'undefined' && location.origin === 'http://127.0.0.1:3000';
  const initialRow = pluginStore.getState().plugins.find(item => item.id === plugin.id);
  const revision = initialRow?.revision;
  const buildDigest = (isLocalDev && initialRow?.buildDigest) || plugin.buildDigest || pluginBuilds.find(build => build.id === plugin.id)?.sourceDigest;
  const current = () => {
    const state = pluginStore.getState();
    const row = state.plugins.find(item => item.id === plugin.id);
    return !!owner && owner === identity(sessionStore.getState().authSession)
      && !options.signal?.aborted && state.loaded && state.installedIds.includes(plugin.id)
      && row?.revision === revision && (!row?.version || row.version === plugin.version)
      && isPluginVisibleToRole(plugin, session.user?.role)
      && state.availabilityById?.[plugin.id]?.available !== false
      && row?.availability?.available !== false;
  };
  const assertCurrent = () => { if (!current()) throw retired(); };
  const transport = createPluginTransport({ pluginId: plugin.id, session, buildDigest, signal: options.signal,
    isCurrent: current, sessionStore, pluginStore, fetchImpl: options.fetch || runtimeFetch,
    onBuildMismatch: () => { if (owner === identity(sessionStore.getState().authSession)) void pluginStore.getState().refresh(session).catch(() => {}); } });
  let queueLease = null;
  const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const queueSnapshot = () => {
    assertCurrent();
    const state = playerStore.getState();
    return state.getQueueSnapshot ? state.getQueueSnapshot() : {
      currentSong: copy(state.currentSong),
      queue: (state.playlist || []).map(copy), isPlaying: state.isPlaying,
      playMode: state.playMode, revision: 0, ready: state.queueContextReady === true,
    };
  };
  const queueWrite = (method, ...args) => {
    assertCurrent();
    if (!queueLease?.active) throw retired();
    if (!queueSnapshot().ready) throw new Error('Player context is not ready');
    return playerStore.getState()[method](...args);
  };
  const subscribeQueue = callback => {
    assertCurrent();
    const listeners = [];
    let ended = false;
    const dispose = () => {
      if (ended) return; ended = true;
      for (const unsubscribe of listeners) unsubscribe();
      options.signal?.removeEventListener('abort', dispose);
    };
    const check = () => { if (!current()) dispose(); };
    listeners.push(playerStore.subscribe(() => { if (current()) callback(queueSnapshot()); else dispose(); }));
    if (sessionStore.subscribe) listeners.push(sessionStore.subscribe(check));
    if (pluginStore.subscribe) listeners.push(pluginStore.subscribe(check));
    options.signal?.addEventListener('abort', dispose, { once: true });
    check(); return dispose;
  };
  return Object.freeze({
    apiVersion: 2, pluginId: plugin.id, version: plugin.version,
    signal: options.signal,
    session: Object.freeze({ get: () => current() ? publicSession : null,
      subscribe: callback => sessionStore.subscribe(() => callback(current() ? publicSession : null)),
      expire() { if (current()) sessionStore.getState().setAuthSession({ initialized: true, authenticated: false, user: null }); } }),
    isCurrent: current, assertCurrent,
    environment: Object.freeze({ demo: isDemoRuntime === true }),
    outputTargets: createOutputCapability({ pluginId: plugin.id, playerStore, audioRef: options.audioRef, isCurrent: current, assertCurrent }),
    contributions: Object.freeze({ register(slot, contribution) {
      assertCurrent();
      const dispose = registerPluginContribution(plugin.id, slot, { ...contribution, isCurrent: current });
      const unsubscribers = [];
      const cleanup = () => { dispose(); for (const unsubscribe of unsubscribers) unsubscribe(); options.signal?.removeEventListener('abort', cleanup); };
      const check = () => { if (!current()) cleanup(); };
      unsubscribers.push(sessionStore.subscribe(check), ...[pluginStore.subscribe?.(check)].filter(Boolean));
      options.signal?.addEventListener('abort', cleanup, { once: true });
      return cleanup;
    } }),
    notify(message) { assertCurrent(); showToast(message); },
    features: Object.freeze({
      isAvailable: feature => current() && pluginStore.getState().availabilityById?.[plugin.id]?.optionalFeatures?.[feature]?.available === true,
    }),
    preferences: Object.freeze({
      getLegacyBoolean(key) {
        assertCurrent();
        if (plugin.id !== 'assistant' || key !== 'thinking') return undefined;
        const ui = sessionStore.getState();
        return ui.assistantEnableThinking ?? ui.xiaoaEnableThinking;
      },
    }),
    musicSources: createPluginMusicSources({ pluginId: plugin.id, playerStore, audioRef: options.audioRef,
      isCurrent: current, assertCurrent, signal: options.signal, sessionStore, pluginStore }),
    lyrics: Object.freeze({ changed(songId, { language } = {}) {
      assertCurrent();
      if (typeof songId !== 'string' || !songId || songId.length > 200) throw new TypeError('Invalid song');
      invalidateLyricsCacheForSong(songId);
      const state = playerStore.getState();
      if (language) state.patchSongMetadata?.(songId, { language });
      state.requestLyricsRefresh?.(songId);
    } }),
    beforeLeave: Object.freeze({
      register(guard) {
        assertCurrent();
        if (typeof guard !== 'function') throw new TypeError('Invalid leave guard');
        const guarded = () => !current() || guard() !== false;
        sessionStore.getState().setLyricsWorkspaceBeforeCloseGuard(guarded);
        const from = options.route;
        const group = plugin.pages.find(page => page.id === from?.pluginPage)?.group;
        const unregister = registerPluginLeaveGuard(destination => {
          if (!current()) return true;
          const next = parsePathname(destination);
          const same = next.pluginId === plugin.id && next.songId === from?.songId
            && plugin.pages.find(page => page.id === next.pluginPage)?.group === group;
          if (same || sessionStore.getState().lyricsWorkspaceExitApproved) return true;
          return guarded();
        });
        return () => { unregister(); if (sessionStore.getState().lyricsWorkspaceBeforeCloseGuard === guarded) sessionStore.getState().setLyricsWorkspaceBeforeCloseGuard(null); };
      },
      approve() { assertCurrent(); return sessionStore.getState().approveLyricsWorkspaceExit(); },
    }),
    catalog: Object.freeze({
      categories: Object.freeze(EXPLORE_CATEGORIES.map(item => Object.freeze({ ...item }))),
      hydrateSong(song) { assertCurrent(); return hydrateSong(song); },
      async resolveSong(songId) {
        assertCurrent();
        if (typeof songId !== 'string' || !songId.trim() || songId.length > 256) throw new TypeError('Invalid song');
        const raw = await fetchSongById(songId); assertCurrent();
        if (!raw) return null;
        const repaired = await repairSongLanguages([raw], { apiBase: getApiBaseUrl() }); assertCurrent();
        const song = hydratePlayableSong(repaired?.songs?.[0]);
        return song && songHasValidLanguage(song) ? song : null;
      },
      openLanguage(language) {
        assertCurrent();
        if (!EXPLORE_CATEGORIES.some(item => item.key === language)) throw new TypeError('Invalid catalog language');
        navigate({ type: 'explore', language });
      },
    }),
    queue: Object.freeze({
      getSnapshot: queueSnapshot,
      subscribe: subscribeQueue,
      getLegacyPreferences() {
        assertCurrent();
        const value = playerStore.getState().getLegacyPluginPreferences?.(plugin.id) || {};
        return { language: typeof value.language === 'string' ? value.language : 'all',
          batchSize: Number.isInteger(value.batchSize) && value.batchSize >= 1 && value.batchSize <= 50 ? value.batchSize : 10 };
      },
      registerContinuation(callbacks) {
        assertCurrent();
        if (queueLease?.active) throw new Error('A queue continuation is already registered');
        const lease = { active: true };
        const guarded = Object.fromEntries(['onQueueEnd', 'onQueueCleared', 'onPause', 'onModeChange', 'onExplicitPlay']
          .map(event => [event, snapshot => {
            if (!lease.active || !current() || !queueSnapshot().ready) return false;
            return callbacks[event]?.(snapshot);
          }]));
        const cleanup = playerStore.getState().registerQueueContinuation(guarded, () => lease.active && current());
        queueLease = lease;
        const listeners = [];
        let ended = false;
        const dispose = () => {
          if (ended) return; ended = true; lease.active = false; cleanup();
          for (const unsubscribe of listeners) unsubscribe();
          options.signal?.removeEventListener('abort', dispose);
        };
        const check = () => { if (!current()) dispose(); };
        if (sessionStore.subscribe) listeners.push(sessionStore.subscribe(check));
        if (pluginStore.subscribe) listeners.push(pluginStore.subscribe(check));
        options.signal?.addEventListener('abort', dispose, { once: true });
        check(); return dispose;
      },
      append: (songs, settings) => queueWrite('appendQueueContinuation', songs, settings),
      start: songs => queueWrite('startQueueContinuation', songs),
      trimAfterCurrent: () => queueWrite('trimQueueAfterCurrent'),
      setSequence: () => queueWrite('setQueueSequence'),
    }),
    navigate(pageId, { songId } = {}) {
      assertCurrent();
      const page = plugin.pages.find(item => item.id === pageId);
      if (!page || !canAccessPluginDeclaration(page, session.user.role)) throw retired();
      navigate({ type: 'page', page: 'plugin', pluginId: plugin.id, pluginPage: pageId, ...(songId ? { songId: String(songId) } : {}) });
    },
    returnToOrigin(fallback = '/home') {
      assertCurrent();
      if (typeof fallback !== 'string' || !fallback.startsWith('/') || fallback.startsWith('//')) throw new TypeError('Invalid return path');
      return returnToOriginRoute(fallback);
    },
    player: Object.freeze({
      capturePlaybackCleanup() { assertCurrent(); return capturePlaybackCleanup(playerStore); },
      getSnapshot: () => {
        const state = playerStore.getState();
        return { ...queueSnapshot(),
          currentTime: state.progress ?? state.currentTime, duration: state.duration, isBuffering: state.isBuffering === true };
      },
      play: song => { assertCurrent(); playerStore.getState().playSong(song); },
      pause: () => { assertCurrent(); playerStore.getState().pause(); },
      execute: action => dispatchScopedPlayerAction(action, { playerStore, isCurrent: current, signal: options.signal,
        subscribe: listener => {
          const a = sessionStore.subscribe(listener), b = pluginStore.subscribe?.(listener);
          return () => { a(); b?.(); };
        }, notify: message => { assertCurrent(); (options.notify || showToast)(message); } }),
      seek(seconds) {
        assertCurrent();
        const value = Number(seconds);
        if (!Number.isFinite(value)) throw new TypeError('Invalid playback position');
        const state = playerStore.getState();
        const audio = state.audioRef?.current;
        const position = Math.max(0, Math.min(value, Number.isFinite(audio?.duration) ? audio.duration : Infinity));
        if (audio) audio.currentTime = position;
        state.setProgress?.(position);
      },
      subscribe: callback => playerStore.subscribe(() => { if (current()) callback(); }),
    }),
    requestResponse: transport.response,
    async request(path = '', { method = 'GET', body, signal = options.signal, admin = false, query = {} } = {}) {
      if (!options.request) return transport.json(path, { method, body, signal, admin, query });
      assertCurrent();
      if (admin && session.user.role !== 'admin') throw retired();
      path = pluginEndpoint(path, query);
      const controller = new AbortController();
      const abort = () => controller.abort();
      const signals = [...new Set([signal, options.signal].filter(Boolean))];
      for (const value of signals) { if (value.aborted) abort(); else value.addEventListener('abort', abort, { once: true }); }
      const check = () => { if (!current()) abort(); };
      const subscriptions = [sessionStore.subscribe(check), pluginStore.subscribe?.(check)].filter(Boolean);
      try {
        assertCurrent();
        if (controller.signal.aborted) throw retired();
        const result = await (options.request || instanceRequest)(`${admin ? 'admin' : 'account'}/plugins/${plugin.id}${path ? `/${path}` : ''}`, {
          method, ...(body === undefined ? {} : { body }), csrfToken: session.csrfToken,
          expectedAccountId: session.user.accountId,
          fetchImpl: (url, init) => runtimeFetch(url, { ...init, signal: controller.signal,
            headers: { ...init.headers, 'X-FlareTune-Expected-Account': session.user.accountId,
              ...(buildDigest ? { 'X-FlareTune-Plugin-Build': buildDigest } : {}) } }),
        });
        assertCurrent();
        if (controller.signal.aborted) throw retired();
        return result;
      } catch (error) {
        if (error?.code === 'PLUGIN_BUILD_MISMATCH' && owner === identity(sessionStore.getState().authSession)) {
          void pluginStore.getState().refresh(session).catch(() => {});
        }
        throw error;
      } finally {
        for (const unsubscribe of subscriptions) unsubscribe();
        for (const value of signals) value.removeEventListener('abort', abort);
      }
    },
  });
}
