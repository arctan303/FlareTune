export const HOST_PLUGIN_API_VERSION = 5;
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
const versionParts = value => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
};
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const access = value => ['authenticated', 'admin'].includes(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const validIntroduction = value => Array.isArray(value) && value.length >= 1 && value.length <= 6
  && Array.from(value).every(paragraph => typeof paragraph === 'string' && paragraph.trim().length > 0 && paragraph.length <= 1500);
const slots = new Set(['sidebar.primary', 'sidebar.settings.admin', 'sidebar.secondary', 'menu.song', 'menu.player']);
const locales = new Set(['zh', 'zh-Hant', 'en', 'ja', 'ko']);
export const normalizePluginUiLanguage = value => {
  const language = String(value || '').split(',')[0].trim();
  if (/^zh-(?:Hant|TW|HK)/iu.test(language)) return 'zh-Hant';
  const primary = language.split('-')[0].toLowerCase();
  return locales.has(primary) ? primary : 'en';
};
const validRoles = value => Array.isArray(value) && value.length > 0 && value.length <= 2
  && value.every(role => ['admin', 'member'].includes(role)) && new Set(value).size === value.length;
const messageKey = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(value);

export function pluginDeclarationRoles(declaration) {
  if (declaration?.roles !== undefined) {
    if (!validRoles(declaration.roles)) return [];
    if (declaration.access !== undefined) {
      const legacy = declaration.access === 'admin' ? ['admin'] : declaration.access === 'authenticated' ? ['admin', 'member'] : [];
      if (legacy.length !== declaration.roles.length || legacy.some(role => !declaration.roles.includes(role))) return [];
    }
    return declaration.roles;
  }
  if (declaration?.access === 'admin') return ['admin'];
  if (declaration?.access === 'authenticated') return ['admin', 'member'];
  return [];
}

export function canAccessPluginDeclaration(declaration, role) {
  return ['admin', 'member'].includes(role) && pluginDeclarationRoles(declaration).includes(role);
}

export function isPluginVisibleToRole(manifest, role) {
  return ['admin', 'member'].includes(role) && ((validRoles(manifest?.capabilityRoles) && manifest.capabilityRoles.includes(role))
    || [...(manifest?.pages || []), ...(manifest?.entries || [])].some(declaration => canAccessPluginDeclaration(declaration, role)));
}

export class PluginManifestError extends Error {
  constructor(code = 'PLUGIN_MANIFEST_INVALID') { super(code); this.name = 'PluginManifestError'; this.code = code; }
}
// Plugin releases use three strict, non-negative safe-integer components.
// Keep UI and delivery ordering on the same numeric contract as validation.
export function comparePluginVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) throw new PluginManifestError();
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}
const invalid = () => { throw new PluginManifestError(); };
const validateAccess = declaration => {
  if (declaration.roles !== undefined && !validRoles(declaration.roles)) invalid();
  if (declaration.access !== undefined && !access(declaration.access)) invalid();
  if (declaration.roles === undefined && !access(declaration.access)) invalid();
  if (declaration.roles !== undefined && declaration.access !== undefined) {
    const legacy = declaration.access === 'admin' ? ['admin'] : ['admin', 'member'];
    if (legacy.length !== declaration.roles.length || legacy.some(role => !declaration.roles.includes(role))) invalid();
  }
};

function validateLocalization(manifest) {
  const fields = ['supportedLocales', 'defaultLocale', 'metadata'];
  if (fields.every(key => manifest[key] === undefined)) {
    if (manifest.messages !== undefined || [...manifest.pages, ...manifest.entries].some(item => item?.labelKey !== undefined)) invalid();
    return;
  }
  if (!Array.isArray(manifest.supportedLocales) || manifest.supportedLocales.length === 0
    || manifest.supportedLocales.some(locale => !locales.has(locale))
    || new Set(manifest.supportedLocales).size !== manifest.supportedLocales.length
    || !manifest.supportedLocales.includes(manifest.defaultLocale) || !plain(manifest.metadata)
    || Object.keys(manifest.metadata).some(locale => !manifest.supportedLocales.includes(locale))) invalid();
  for (const locale of manifest.supportedLocales) {
    const metadata = manifest.metadata[locale];
    if (!plain(metadata) || !text(metadata.name) || !text(metadata.description)
      || (metadata.introduction !== undefined && !validIntroduction(metadata.introduction))) invalid();
  }
  const keys = [...manifest.pages, ...manifest.entries].map(item => item?.labelKey).filter(key => key !== undefined);
  if (manifest.messages !== undefined && (!plain(manifest.messages)
    || Object.keys(manifest.messages).some(locale => !manifest.supportedLocales.includes(locale)))) invalid();
  for (const locale of manifest.supportedLocales) {
    const messages = manifest.messages?.[locale];
    if (messages !== undefined && (!plain(messages) || Object.entries(messages).some(([key, value]) => !messageKey(key) || !text(value)))) invalid();
    if (keys.some(key => !messageKey(key) || !text(messages?.[key]))) invalid();
  }
}

export function canonicalPluginManifest(manifest) {
  const seen = new Set();
  const normalize = (value, depth = 0) => {
    if (depth > 20 || (typeof value === 'number' && !Number.isFinite(value))) invalid();
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (!value || typeof value !== 'object' || seen.has(value)
      || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) invalid();
    seen.add(value);
    const result = Array.isArray(value) ? value.map(item => normalize(item, depth + 1))
      : Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key], depth + 1)]));
    seen.delete(value);
    return result;
  };
  const result = JSON.stringify(normalize(manifest));
  if (result.length > 65536) invalid();
  return result;
}

export function satisfiesPluginVersion(version, requirement) {
  const actual = versionParts(version);
  if (!actual || typeof requirement !== 'string') return false;
  const operator = /^[~^]/.exec(requirement)?.[0] || '';
  const expected = versionParts(requirement.slice(operator.length));
  if (!expected) return false;
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (!operator) return compare(actual, expected) === 0;
  if (compare(actual, expected) < 0) return false;
  const upper = operator === '~' ? [expected[0], expected[1] + 1, 0]
    : expected[0] > 0 ? [expected[0] + 1, 0, 0]
      : expected[1] > 0 ? [0, expected[1] + 1, 0] : [0, 0, expected[2] + 1];
  return compare(actual, upper) < 0;
}

// Missing dependencies and cycles are availability problems, not a reason to
// prevent the host from listing a package with an actionable explanation.
export function validatePluginManifests(manifests) {
  if (!Array.isArray(manifests) || manifests.length > 128) invalid();
  const ids = new Set();
  for (const manifest of manifests) {
    canonicalPluginManifest(manifest);
    if (!plain(manifest) || !identifier(manifest.id) || ids.has(manifest.id) || !versionParts(manifest.version)
      || !Number.isSafeInteger(manifest.hostApiVersion) || manifest.hostApiVersion < 1
      || !Number.isSafeInteger(manifest.apiVersion) || manifest.apiVersion < 1
      || (manifest.dataVersion !== undefined && (!Number.isSafeInteger(manifest.dataVersion) || manifest.dataVersion < 0))
      || !text(manifest.name) || !text(manifest.description) || !identifier(manifest.icon)
      || !Array.isArray(manifest.pages) || !Array.isArray(manifest.entries)) invalid();
    ids.add(manifest.id);
    if (manifest.introduction !== undefined && !validIntroduction(manifest.introduction)) invalid();
    if (manifest.capabilityRoles !== undefined && !validRoles(manifest.capabilityRoles)) invalid();
    validateLocalization(manifest);
    const pages = new Map();
    for (const page of manifest.pages) {
      if (!plain(page) || !identifier(page.id) || page.id === 'overview' || pages.has(page.id)
        || !['settings', 'service'].includes(page.kind)
        || !['inherit', 'sidebar'].includes(page.playerPlacement || 'inherit')
        || (page.presentation !== undefined && !['standard', 'workspace'].includes(page.presentation))
        || (!text(page.label) && !messageKey(page.labelKey)) || !identifier(page.icon) || (page.group !== undefined && !identifier(page.group))
        || (page.groupLabel !== undefined && !text(page.groupLabel))) invalid();
      validateAccess(page);
      if (page.scope !== undefined && (page.kind !== 'settings' || !['account', 'instance'].includes(page.scope))) invalid();
      if (page.scope === 'instance' && pluginDeclarationRoles(page).some(role => role !== 'admin')) invalid();
      pages.set(page.id, page);
    }
    const entries = new Set();
    const navigationGroups = new Set([manifest.id, ...manifest.pages.map(page => page.group).filter(Boolean)]);
    const optionalFeatureIds = new Set(Object.entries(manifest.optionalDependencies || {}).flatMap(([id, declaration]) =>
      Array.isArray(declaration?.features) ? declaration.features : [id]));
    for (const entry of manifest.entries) {
      if (!plain(entry) || !identifier(entry.id) || entries.has(entry.id) || !slots.has(entry.slot)
        || (!text(entry.label) && !messageKey(entry.labelKey)) || !identifier(entry.icon) || !Number.isSafeInteger(entry.order)
        || Boolean(entry.page) === Boolean(entry.action)
        || (entry.page && !pages.has(entry.page)) || (entry.action && !identifier(entry.action))
        || (entry.group !== undefined && !identifier(entry.group))
        || (entry.slot === 'sidebar.secondary' && (!entry.group || !navigationGroups.has(entry.group)))
        || (entry.when !== undefined && (!Array.isArray(entry.when) || entry.when.some(condition => !['song', 'playing', 'output'].includes(condition))
          || new Set(entry.when).size !== entry.when.length))
        || (entry.feature !== undefined && (!identifier(entry.feature) || !optionalFeatureIds.has(entry.feature)))) invalid();
      validateAccess(entry);
      if (entry.page && pluginDeclarationRoles(entry).some(role => !canAccessPluginDeclaration(pages.get(entry.page), role))) invalid();
      entries.add(entry.id);
    }
    const features = new Set();
    if (manifest.serviceConfigurations !== undefined) {
      if (!plain(manifest.serviceConfigurations) || Object.keys(manifest.serviceConfigurations).length > 16) invalid();
      let count = 0;
      for (const [providerId, configurations] of Object.entries(manifest.serviceConfigurations)) {
        if (!identifier(providerId) || providerId === manifest.id
          || (!Object.hasOwn(manifest.dependencies || {}, providerId) && !Object.hasOwn(manifest.optionalDependencies || {}, providerId))
          || !Array.isArray(configurations) || !configurations.length || configurations.length > 16
          || configurations.some(slot => !identifier(slot)) || new Set(configurations).size !== configurations.length) invalid();
        count += configurations.length;
      }
      if (count > 32) invalid();
    }
    for (const key of ['dependencies', 'optionalDependencies']) {
      if (manifest[key] === undefined) continue;
      if (!plain(manifest[key])) invalid();
      for (const [dependencyId, declaration] of Object.entries(manifest[key])) {
        if (!identifier(dependencyId) || !plain(declaration) || !Number.isSafeInteger(declaration.apiVersion) || declaration.apiVersion < 1
          || (declaration.version !== undefined && !/^[~^]?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(declaration.version))
          || (key === 'optionalDependencies' && Object.hasOwn(manifest.dependencies || {}, dependencyId))) invalid();
        if (declaration.features !== undefined && (!Array.isArray(declaration.features)
          || declaration.features.length === 0 || declaration.features.some(feature => !identifier(feature)))) invalid();
        if (key === 'optionalDependencies') for (const feature of declaration.features || [dependencyId]) {
          if (features.has(feature)) invalid();
          features.add(feature);
        }
      }
    }
  }
  return manifests;
}

function requiredIssues(manifests, installed, pluginId) {
  const byId = new Map(manifests.map(manifest => [manifest.id, manifest]));
  const issues = [];
  const visited = new Set();
  const visit = (id, path) => {
    if (path.has(id)) { issues.push({ code: 'dependency_cycle', pluginId: id }); return; }
    if (visited.has(id)) return;
    const manifest = byId.get(id);
    if (!manifest) { issues.push({ code: 'missing_dependency', pluginId, dependencyId: id }); return; }
    if (manifest.hostApiVersion > HOST_PLUGIN_API_VERSION) issues.push({ code: 'host_incompatible', pluginId: id });
    const next = new Set(path); next.add(id);
    for (const [dependencyId, declaration] of Object.entries(manifest.dependencies || {})) {
      const dependency = byId.get(dependencyId);
      if (!dependency) { issues.push({ code: 'missing_dependency', pluginId: id, dependencyId }); continue; }
      if (dependency.apiVersion !== declaration.apiVersion || (declaration.version && !satisfiesPluginVersion(dependency.version, declaration.version))) {
        issues.push({ code: 'incompatible_dependency', pluginId: id, dependencyId });
      }
      if (!installed.has(dependencyId)) issues.push({ code: 'dependency_not_installed', pluginId: id, dependencyId });
      visit(dependencyId, next);
    }
    visited.add(id);
  };
  if (!installed.has(pluginId)) issues.push({ code: 'not_installed', pluginId });
  visit(pluginId, new Set());
  return issues;
}

export function resolvePluginAvailability(manifests, installedIds, pluginId) {
  validatePluginManifests(manifests);
  const installed = new Set(installedIds);
  const manifest = manifests.find(item => item.id === pluginId);
  const issues = requiredIssues(manifests, installed, pluginId);
  const optionalFeatures = {};
  for (const [dependencyId, declaration] of Object.entries(manifest?.optionalDependencies || {})) {
    const dependency = manifests.find(item => item.id === dependencyId);
    const reason = !dependency ? 'missing_dependency' : !installed.has(dependencyId) ? 'dependency_not_installed'
      : dependency.apiVersion !== declaration.apiVersion || (declaration.version && !satisfiesPluginVersion(dependency.version, declaration.version))
        ? 'incompatible_dependency' : requiredIssues(manifests, installed, dependencyId)[0]?.code || null;
    for (const feature of declaration.features || [dependencyId]) optionalFeatures[feature] = { available: reason === null, reason, dependencyId };
  }
  return { available: issues.length === 0, reason: issues[0]?.code || null, issues, optionalFeatures };
}

export function getRequiredDependents(manifests, installedIds, pluginId) {
  validatePluginManifests(manifests);
  const installed = new Set(installedIds);
  const dependsOn = new Set([pluginId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const manifest of manifests) if (!dependsOn.has(manifest.id)
      && Object.keys(manifest.dependencies || {}).some(id => dependsOn.has(id))) {
      dependsOn.add(manifest.id); changed = true;
    }
  }
  return manifests.filter(manifest => manifest.id !== pluginId && installed.has(manifest.id) && dependsOn.has(manifest.id)).map(manifest => manifest.id);
}
