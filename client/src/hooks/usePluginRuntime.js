import { useEffect } from 'react';
import { useUIStore } from '../store/useUIStore.js';
import { usePluginStore } from '../store/usePluginStore.js';
import { getPlugins } from '../plugins/registry.js';
import { pluginBindings } from '../plugins/compiled.js';
import { createPluginHost } from '../plugins/host.js';
import { createPluginRuntime } from '../plugins/runtime.js';
import { pluginBuilds } from '../../../shared/plugins/build.generated.js';
import { t } from '../i18n/index.js';

export function usePluginRuntime({ audioRef }) {
  useEffect(() => {
    const runtime = createPluginRuntime({
      plugins: getPlugins().map(plugin => ({ ...plugin,
        buildDigest: pluginBuilds.find(build => build.id === plugin.id)?.sourceDigest,
        start: pluginBindings[plugin.id]?.start })),
      getState: () => {
        const session = useUIStore.getState().authSession, state = usePluginStore.getState();
        return { subject: session?.authenticated ? JSON.stringify([session.user?.accountId, session.user?.role, session.csrfToken]) : '',
          role: session?.authenticated ? session.user?.role : null,
          rows: state.plugins, loaded: state.loaded };
      },
      subscribe: callback => {
        const a = useUIStore.subscribe(callback), b = usePluginStore.subscribe(callback);
        return () => { a(); b(); };
      },
      createHost: (plugin, signal) => ({ ...createPluginHost(plugin, { signal, audioRef }), audioRef }),
      onError: () => useUIStore.getState().showToast?.(t('插件内容加载失败，请重试。')),
    });
    return () => runtime.dispose();
  }, [audioRef]);
}
