import { create } from 'zustand';
import { useUIStore } from './useUIStore.js';
import { pluginsRequest } from '../services/plugins.js';
import { compiledPluginManifests } from '../../../shared/plugins/catalog.js';
import { resolvePluginAvailability } from '../../../shared/plugins/manifest.js';
import { pluginBuilds } from '../../../shared/plugins/build.generated.js';

const subject = (session) => session?.authenticated && session.user?.accountId
  ? JSON.stringify([session.user.accountId, session.csrfToken, session.user.role]) : '';
const blankList = () => ({ plugins: [], loaded: false, loading: false, error: '' });
const initial = () => ({ plugins: [], installedIds: [], availabilityById: {}, loaded: false, loading: false, error: '', busy: false,
  scope: 'account', lists: { account: blankList(), admin: blankList() } });
const validRow = row => row && typeof row.id === 'string' && typeof row.version === 'string'
  && typeof row.installed === 'boolean' && Number.isSafeInteger(row.revision) && row.revision >= 0;
const aborted = () => new DOMException('Plugin session ended', 'AbortError');
const isLocalDev = () => typeof location !== 'undefined' && location.origin === 'http://127.0.0.1:3000';
const availability = (rows, installedIds) => Object.fromEntries(rows.map(row => {
  const manifest = compiledPluginManifests.find(plugin => plugin.id === row.id);
  const build = pluginBuilds.find(plugin => plugin.id === row.id);
  const resolved = manifest && (manifest.version !== row.version || (!isLocalDev() && build && row.buildDigest !== build.sourceDigest))
    ? { available: false, reason: 'incompatible_version', issues: [{ code: 'incompatible_version', pluginId: row.id }], optionalFeatures: {} }
    : resolvePluginAvailability(compiledPluginManifests, installedIds, row.id);
  const server = row.availability;
  const combined = resolved.available && server?.available === false ? { ...resolved, ...server } : { ...server, ...resolved };
  combined.optionalFeatures = { ...server?.optionalFeatures, ...resolved.optionalFeatures };
  for (const [feature, state] of Object.entries(server?.optionalFeatures || {})) {
    if (state.available === false && combined.optionalFeatures[feature]?.available !== false) combined.optionalFeatures[feature] = state;
  }
  return [row.id, combined];
}));
const mutationError = error => ({
  PLUGIN_DEPENDENCY_MISSING: '插件所需依赖尚不可用，请先检查依赖。',
  PLUGIN_DEPENDENCY_INCOMPATIBLE: '插件所需依赖版本不兼容。',
  PLUGIN_DEPENDENCY_CYCLE: '插件依赖存在循环，请联系管理员。',
  PLUGIN_HOST_INCOMPATIBLE: '插件与当前宿主版本不兼容。',
  PLUGIN_REQUIRED_BY: '其他已安装插件依赖此插件，请先卸载依赖它的插件。',
  PLUGIN_REQUIRED_DEPENDENCY: '插件所需依赖尚不可用，请先检查依赖。',
  PLUGIN_DEPENDENCY_UNAVAILABLE: '插件所需依赖尚不可用，请先检查依赖。',
  PLUGIN_DEPENDENTS_INSTALLED: '其他已安装插件依赖此插件，请先卸载依赖它的插件。',
  PLUGIN_REQUIRED_BY_INSTALLED: '其他已安装插件依赖此插件，请先卸载依赖它的插件。',
}[error?.code] || (error?.status === 409 ? '插件状态已变化，请刷新后重试。' : '插件安装状态未保存，请重试。'));

export function createPluginStore({ getSession, request = pluginsRequest } = {}) {
  let owner = '', generation = 0, mutation = 0;
  const pending = new Map(), controllers = new Set();
  return create((set, get) => {
    const current = (session, version) => owner === subject(session) && owner === subject(getSession()) && generation === version;
    const assertSession = (session) => {
      const key = subject(session);
      if (!key || key !== subject(getSession())) throw aborted();
      if (owner !== key) { get().reset(); owner = key; }
      return generation;
    };
    const updateList = (scope, patch) => set(state => {
      const lists = { ...state.lists, [scope]: { ...state.lists[scope], ...patch } };
      return { lists, loading: Object.values(lists).some(list => list.loading) };
    });
    return { ...initial(),
      reset() {
        generation++; mutation++; owner = '';
        for (const controller of controllers) controller.abort();
        controllers.clear(); pending.clear(); set(initial());
      },
      isInstalled: id => get().loaded && get().installedIds.includes(id),
      isAvailable: id => get().loaded && get().installedIds.includes(id) && get().availabilityById[id]?.available === true,
      markUninstalled(id) {
        mutation++;
        set(state => {
          const installedIds = state.installedIds.filter(entry => entry !== id);
          const plugins = state.plugins.map(row => row.id === id ? { ...row, installed: false } : row);
          return { installedIds, plugins, availabilityById: availability(plugins, installedIds),
          lists: Object.fromEntries(Object.entries(state.lists).map(([scope, list]) => [scope, { ...list,
            plugins: scope === 'account' ? list.plugins.filter(row => row.id !== id)
              : list.plugins.map(row => row.id === id ? { ...row, installed: false } : row) }])) };
        });
      },
      refresh(session, { admin = false } = {}) {
        let version;
        try { version = assertSession(session); } catch (error) { return Promise.reject(error); }
        const scope = admin ? 'admin' : 'account';
        if (admin && session.user.role !== 'admin') return Promise.reject(new Error('Plugin administrator required'));
        if (pending.has(scope)) return pending.get(scope);
        const controller = new AbortController(), baseline = mutation;
        controllers.add(controller); updateList(scope, { loading: true, error: '' });
        let task;
        task = Promise.resolve().then(async () => {
          try {
            const result = await request(session, { admin, signal: controller.signal });
            if (!current(session, version) || controller.signal.aborted) throw aborted();
            if (!Array.isArray(result?.plugins) || !result.plugins.every(validRow)) throw new Error('Invalid plugin list');
            if (baseline === mutation) {
              const plugins = result.plugins;
              const dependencyInstalledIds = result.dependencyInstalledIds || [];
              if (!Array.isArray(dependencyInstalledIds) || !dependencyInstalledIds.every(id => typeof id === 'string'
                && compiledPluginManifests.some(manifest => manifest.id === id))) throw new Error('Invalid plugin dependencies');
              const installedIds = [...new Set([...plugins.filter(row => row.installed).map(row => row.id), ...dependencyInstalledIds])];
              updateList(scope, { plugins, loaded: true });
              set({ plugins, installedIds, availabilityById: availability(plugins, installedIds), loaded: true, scope, error: '' });
            }
            return result;
          } catch (error) {
            if (current(session, version) && !controller.signal.aborted) {
              updateList(scope, { error: '插件列表加载失败，请重试。' }); set({ error: '插件列表加载失败，请重试。' });
            }
            throw error;
          } finally {
            controllers.delete(controller);
            if (pending.get(scope) === task) pending.delete(scope);
            if (current(session, version)) updateList(scope, { loading: false });
          }
        });
        pending.set(scope, task); return task;
      },
      async setInstalled(id, installed, revision, session) {
        const version = assertSession(session);
        if (session.user.role !== 'admin' || get().busy || typeof installed !== 'boolean' || !Number.isSafeInteger(revision)) throw new Error('Plugin update unavailable');
        const controller = new AbortController(); controllers.add(controller); mutation++;
        set({ busy: true, error: '' });
        try {
          const result = await request(session, { admin: true, id, installed, revision, signal: controller.signal });
          if (!current(session, version) || controller.signal.aborted) throw aborted();
          if (!validRow(result?.plugin) || result.plugin.id !== id) throw new Error('Invalid plugin update');
          mutation++;
          const row = result.plugin;
          set(state => {
            const merge = rows => [...rows.filter(entry => entry.id !== id), row];
            const plugins = merge(state.plugins), installedIds = row.installed
              ? [...new Set([...state.installedIds, id])] : state.installedIds.filter(entry => entry !== id);
            return { plugins, installedIds, availabilityById: availability(plugins, installedIds), loaded: true,
            lists: { admin: { ...state.lists.admin, plugins: merge(state.lists.admin.plugins) },
              account: { ...state.lists.account, plugins: row.installed ? merge(state.lists.account.plugins) : state.lists.account.plugins.filter(entry => entry.id !== id) } } };
          });
          return row;
        } catch (error) {
          if (current(session, version) && !controller.signal.aborted) set({ error: mutationError(error) });
          throw error;
        } finally { controllers.delete(controller); if (current(session, version)) set({ busy: false }); }
      },
    };
  });
}

export const usePluginStore = createPluginStore({ getSession: () => useUIStore.getState().authSession });
useUIStore.subscribe((next, previous) => {
  if (subject(next.authSession) !== subject(previous.authSession)) usePluginStore.getState().reset();
});
