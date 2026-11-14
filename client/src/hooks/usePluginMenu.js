import { useState } from 'react';
import { useLocale } from '../i18n/index.js';
import { useUIStore } from '../store/useUIStore.js';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { usePluginStore } from '../store/usePluginStore.js';
import { useOutputTargetStore } from '../store/useOutputTargetStore.js';
import { getPluginEntries, getPluginEntryRoute } from '../plugins/registry.js';
import { pluginBindings } from '../plugins/compiled.js';
import { createPluginMenuContext } from '../plugins/menu.js';
import { formatPath, syncBrowserHistory } from '../utils/navigation.js';

export function usePluginMenu(slot, { song } = {}) {
  const locale = useLocale();
  const session = useUIStore(state => state.authSession);
  const state = usePluginStore();
  const currentSong = usePlayerStore(state => state.currentSong);
  const playing = usePlayerStore(state => state.isPlaying);
  const output = useOutputTargetStore(state => state.target);
  const [selection, setSelection] = useState(null);
  const entries = getPluginEntries(slot, {
    locale,
    authenticated: session?.authenticated === true, isAdmin: session?.user?.role === 'admin',
    installedIds: state.loaded ? state.installedIds : [],
    availabilityById: state.availabilityById,
    song: slot === 'menu.song' ? song : currentSong, playing, output,
  }).filter(entry => entry.page || pluginBindings[entry.pluginId]?.actions?.includes(entry.action));
  return { entries, selection, close: () => setSelection(null),
    open(entry) {
      // Recheck the current store even if this menu was opened before uninstall.
      const current = usePluginStore.getState();
      if (!current.installedIds.includes(entry.pluginId) || current.availabilityById?.[entry.pluginId]?.available === false) return;
      if (entry.page) { syncBrowserHistory(formatPath(getPluginEntryRoute(entry))); return; }
      setSelection({ entry, session, revision: current.plugins.find(row => row.id === entry.pluginId)?.revision,
        context: createPluginMenuContext(slot, {
        song, player: usePlayerStore.getState(), output: useOutputTargetStore.getState().target,
      }) });
    },
  };
}
