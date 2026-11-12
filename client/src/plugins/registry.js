import { Speaker, Info, Link2, Play, Puzzle, Settings, Activity, Library, ListMusic, Music, Shuffle, MessageCircle, Languages, Trash2 } from 'lucide-react';
import { compiledPluginManifests } from '../../../shared/plugins/catalog.js';
import { validatePluginManifests, resolvePluginAvailability, canAccessPluginDeclaration, isPluginVisibleToRole } from '../../../shared/plugins/manifest.js';
export { canAccessPluginDeclaration, isPluginVisibleToRole } from '../../../shared/plugins/manifest.js';
import { pluginBuilds } from '../../../shared/plugins/build.generated.js';
import { deliveryPluginBindings } from './delivery.generated.js';

const hostIcons = Object.freeze({ speaker: Speaker, info: Info, link: Link2, play: Play, puzzle: Puzzle,
  settings: Settings, activity: Activity, library: Library, list: ListMusic, music: Music, shuffle: Shuffle, message: MessageCircle, lyrics: Languages, trash: Trash2 });
const modules = deliveryPluginBindings;
const roleFor = ({ isAdmin = false, authenticated = true, role } = {}) => authenticated ? role || (isAdmin ? 'admin' : 'member') : null;
const canAccess = (declaration, options) => canAccessPluginDeclaration(declaration, roleFor(options));
const overview = Object.freeze({ id: 'overview', label: '概览', icon: Info, kind: 'settings', access: 'authenticated',
  playerPlacement: 'inherit', availableBeforeInstall: true, scope: 'account' });

// This is a stable declaration identity, not an authorization decision.
export const getPrimaryPluginSettingsPageId = plugin => plugin?.pages?.find(page => page.kind === 'settings')?.id ?? null;

export function localizePlugin(plugin, requestedLocale) {
  if (!plugin) return null;
  const supportedLocales = plugin.supportedLocales;
  if (!supportedLocales?.length) return { ...plugin, introduction: [...(plugin.introduction || [])], introductionLocale: null,
    localization: { locale: requestedLocale, fallback: false } };
  const locale = supportedLocales.includes(requestedLocale) ? requestedLocale : plugin.defaultLocale;
  const metadata = plugin.metadata?.[locale] || plugin.metadata?.[plugin.defaultLocale];
  const defaultIntroduction = plugin.metadata?.[plugin.defaultLocale]?.introduction;
  const introduction = metadata?.introduction || defaultIntroduction || plugin.introduction || [];
  const introductionLocale = metadata?.introduction ? locale : defaultIntroduction ? plugin.defaultLocale : null;
  const label = declaration => declaration.labelKey
    ? plugin.messages?.[locale]?.[declaration.labelKey] || plugin.messages?.[plugin.defaultLocale]?.[declaration.labelKey] || declaration.label
    : declaration.label;
  return { ...plugin, name: metadata?.name || plugin.name, description: metadata?.description || plugin.description,
    introduction: [...introduction], introductionLocale,
    pages: plugin.pages.map(page => ({ ...page, label: label(page) })),
    entries: plugin.entries.map(entry => ({ ...entry, label: label(entry) })),
    localization: { locale, fallback: locale !== requestedLocale } };
}

// UI loaders are trusted build-time bindings. Manifests declare data; no
// installation response can introduce executable URLs or packages.
export function createPluginRegistry(manifests, bindings = {}, icons = hostIcons) {
  validatePluginManifests(manifests);
  const plugins = Object.freeze(manifests.map(manifest => Object.freeze({ ...manifest, ...bindings[manifest.id],
    installationScope: 'admin', icon: icons[manifest.icon] || Puzzle,
    pages: Object.freeze(manifest.pages.map(page => Object.freeze({ ...page, icon: icons[page.icon] || Puzzle,
      ...(page.kind === 'settings' ? { scope: page.scope || (page.access === 'admin' ? 'instance' : 'account') } : {}) }))),
    entries: Object.freeze(manifest.entries.map(entry => Object.freeze({ ...entry, icon: icons[entry.icon] || Puzzle }))),
  })));
  const getPlugin = id => plugins.find(plugin => plugin.id === id) || null;
  const resolve = plugin => typeof plugin === 'string' ? getPlugin(plugin) : plugin;
  const getPluginAvailability = (id, { installedIds = [], availabilityById = {} } = {}) => {
    const resolved = resolvePluginAvailability(manifests, installedIds, id);
    const remote = availabilityById[id];
    if (!resolved.available || !remote) return resolved;
    const optionalFeatures = { ...resolved.optionalFeatures, ...remote.optionalFeatures };
    for (const [feature, state] of Object.entries(resolved.optionalFeatures)) if (!state.available) optionalFeatures[feature] = state;
    return { ...resolved, ...remote, optionalFeatures };
  };
  const getPluginPages = (value, options = {}) => {
    const plugin = resolve(value); const role = roleFor(options);
    if (!plugin || !role || (role !== 'admin' && !isPluginVisibleToRole(plugin, role))) return [];
    const installed = options.installed ?? options.installedIds?.includes(plugin.id) ?? false;
    const available = options.available ?? (options.installedIds
      ? getPluginAvailability(plugin.id, options).available : installed);
    return [overview, ...(installed && available ? plugin.pages.filter(page => canAccess(page, options)) : [])];
  };
  const getPluginPage = (value, id) => id === 'overview' ? (resolve(value) ? overview : null)
    : resolve(value)?.pages.find(page => page.id === id) || null;
  const getPluginEntries = (slot, options = {}) => plugins.flatMap(original => {
    const plugin = options.locale ? localizePlugin(original, options.locale) : original;
    if (options.pluginId && options.pluginId !== plugin.id) return [];
    const availability = getPluginAvailability(plugin.id, options);
    if (!availability.available) return [];
    return plugin.entries.filter(entry => entry.slot === slot && canAccess(entry, options)
      && (options.group === undefined || entry.group === options.group)
      && (entry.when || []).every(condition => !!options[condition])
      && (!entry.feature || availability.optionalFeatures?.[entry.feature]?.available === true)
      && (!entry.page || canAccess(getPluginPage(plugin, entry.page), options)))
      .map(entry => ({ ...entry, pluginId: plugin.id, plugin }));
  }).sort((a, b) => a.order - b.order || a.pluginId.localeCompare(b.pluginId) || a.id.localeCompare(b.id));
  return Object.freeze({ getPlugins: () => plugins, getPlugin, getPluginPages, getPluginPage,
    getPluginSections: getPluginPages, getPluginAvailability, getPluginEntries });
}

const registry = createPluginRegistry(compiledPluginManifests, Object.fromEntries(compiledPluginManifests.map(plugin => [plugin.id,
  { ...modules[plugin.id], buildDigest: pluginBuilds.find(build => build.id === plugin.id)?.sourceDigest }])));
export const { getPlugins, getPlugin, getPluginPages, getPluginPage, getPluginSections,
  getPluginAvailability, getPluginEntries } = registry;
export const getPluginEntryRoute = entry => entry?.page ? {
  type: 'page', page: 'plugin', pluginId: entry.pluginId, pluginPage: entry.page,
} : null;
