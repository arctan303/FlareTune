import { notifyMusicSourcesChanged, subscribeMusicSources } from '../services/musicSources.js';
import { pauseRetiredMusicSourcePlayback } from '../services/musicSourcePlayback.js';

// One live plugin source owns its matching media lifetime. Retirement can still
// stop that source after the plugin loses authority, but exposes no player store
// to the plugin and never resumes playback or removes saved queue entries.
export function createPluginMusicSources({ pluginId, playerStore, audioRef,
  isCurrent, assertCurrent, signal, sessionStore, pluginStore }) {
  let registration = null;
  return Object.freeze({
    changed() {
      assertCurrent();
      notifyMusicSourcesChanged(pluginId);
    },
    register({ matches } = {}) {
      assertCurrent();
      if (typeof matches !== 'function') throw new TypeError('A music source must match its songs');
      if (registration) throw new Error('A music source is already registered');
      const entry = { active: true };
      registration = entry;
      const subscriptions = [];
      const pause = () => pauseRetiredMusicSourcePlayback(playerStore, matches, audioRef);
      const dispose = () => {
        if (!entry.active) return;
        entry.active = false;
        if (registration === entry) registration = null;
        for (const unsubscribe of subscriptions) unsubscribe();
        signal?.removeEventListener('abort', dispose);
        pause();
        notifyMusicSourcesChanged(pluginId);
      };
      const check = () => { if (!isCurrent()) dispose(); };
      subscriptions.push(subscribeMusicSources((_revision, changedPluginId) => {
        if (!entry.active) return;
        if (!isCurrent()) { dispose(); return; }
        if (changedPluginId === undefined || changedPluginId === pluginId) pause();
      }));
      if (sessionStore?.subscribe) subscriptions.push(sessionStore.subscribe(check));
      if (pluginStore?.subscribe) subscriptions.push(pluginStore.subscribe(check));
      signal?.addEventListener('abort', dispose, { once: true });
      if (!isCurrent() || signal?.aborted) dispose();
      else notifyMusicSourcesChanged(pluginId);
      return dispose;
    },
  });
}
