import {
  canonicalPluginManifest,
  comparePluginVersions,
  resolvePluginAvailability,
  validatePluginManifests,
} from '../../../shared/plugins/manifest.js';

const rowsOf = value => Array.isArray(value) ? value : [];
const sourceOf = row => row?.sourceId || row?.source?.id || '';
const textOrder = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const versionIsValid = version => {
  try { comparePluginVersions(version, version); return true; } catch { return false; }
};
const signature = row => {
  try { return canonicalPluginManifest(row); }
  catch { return JSON.stringify([row?.id, sourceOf(row), row?.version]); }
};
const rowOrder = (left, right) => {
  const leftValid = versionIsValid(left?.version), rightValid = versionIsValid(right?.version);
  return (leftValid && rightValid ? -comparePluginVersions(left.version, right.version) : Number(rightValid) - Number(leftValid))
    || textOrder(sourceOf(left), sourceOf(right)) || textOrder(signature(left), signature(right));
};
const targetData = row => ({ id: row.id, version: row.version, manifest: row.manifest ?? null, source: row.source ?? null });
export const catalogTargetKey = row => signature(targetData(row));
export const sameCatalogTarget = (left, right) => {
  if (!left || !right || left.id !== right.id || left.version !== right.version || sourceOf(left) !== sourceOf(right)) return false;
  try { return canonicalPluginManifest(targetData(left)) === canonicalPluginManifest(targetData(right)); }
  catch { return false; }
};
const sameTarget = sameCatalogTarget;
const sourceIsAvailable = (data, sourceId) => sourceId === 'workspace'
  || Boolean(sourceId && rowsOf(data?.sources).some(source => source.id === sourceId && source.status === 'ready'));

function catalogContext(data) {
  const catalog = rowsOf(data?.catalog).filter(row => typeof row?.id === 'string' && row.id);
  const running = rowsOf(data?.running).filter(row => typeof row?.id === 'string' && row.id);
  const desired = rowsOf(data?.desired ?? data?.running).filter(row => typeof row?.id === 'string' && row.id);
  const all = [...catalog, ...running, ...desired].sort(rowOrder);
  const rowFor = (rows, id) => rows.filter(row => row.id === id).sort(rowOrder)[0] || null;
  return { data, catalog, running, desired, all,
    runningFor: id => rowFor(running, id), desiredFor: id => rowFor(desired, id) };
}

function combinationFailure(context, candidate) {
  const selected = [...context.desired.filter(row => row.id !== candidate.id), candidate]
    .sort((left, right) => textOrder(left.id, right.id));
  try {
    if (selected.some(row => row.manifest?.id !== row.id || row.manifest?.version !== row.version)) return 'invalid_manifest';
    const manifests = selected.map(row => row.manifest), ids = selected.map(row => row.id);
    for (const row of selected) {
      const result = resolvePluginAvailability(manifests, ids, row.id);
      if (!result.available) return result.reason || 'incompatible_dependency';
    }
    return null;
  } catch { return 'invalid_manifest'; }
}

function candidateState(context, row, { includeSelected = false } = {}) {
  const unavailable = reason => ({ operation: null, available: false, reason });
  if (!row || typeof row.id !== 'string' || !versionIsValid(row.version)
    || row.manifest?.id !== row.id || row.manifest?.version !== row.version) return unavailable('invalid_manifest');
  const running = context.runningFor(row.id), desired = context.desiredFor(row.id);
  if ([running, desired].some(owner => owner && !versionIsValid(owner.version))) return unavailable('invalid_manifest');
  if ([running, desired].some(owner => owner && sourceOf(owner) !== sourceOf(row))) return unavailable('source_conflict');
  if (running && comparePluginVersions(row.version, running.version) <= 0) {
    return unavailable(sameTarget(row, running) ? 'current' : 'not_newer');
  }
  if (desired) {
    const comparison = comparePluginVersions(row.version, desired.version);
    if (comparison < 0 || comparison === 0 && !sameTarget(row, desired)) return unavailable('not_newer');
    if (!includeSelected && sameTarget(row, desired)) return unavailable('selected');
  }
  if (!sourceIsAvailable(context.data, sourceOf(row))) return unavailable('source_unavailable');
  if (!context.catalog.some(candidate => sameTarget(candidate, row))) return unavailable('not_found');
  const failure = combinationFailure(context, row);
  return failure ? unavailable(failure) : { operation: running ? 'update' : 'install', available: true, reason: null };
}

/** The action for one exact published package; inspecting a snapshot never selects it. */
export function catalogCandidateState(data, row) {
  try { return candidateState(catalogContext(data), row); }
  catch { return { operation: null, available: false, reason: 'invalid_manifest' }; }
}

// Compatibility is independent of whether this historical package can be
// selected as an action, whether its source is online, or who owns the plugin.
export function catalogVersionAvailability(data, row) {
  try {
    if (!row || typeof row.id !== 'string' || !versionIsValid(row.version)
      || row.manifest?.id !== row.id || row.manifest?.version !== row.version) {
      return { available: false, reason: 'invalid_manifest' };
    }
    validatePluginManifests([row.manifest]);
    const reason = combinationFailure(catalogContext(data), row);
    return { available: reason === null, reason };
  } catch { return { available: false, reason: 'invalid_manifest' }; }
}

function pluginModel(context, id, { sourceId = '', version = '' } = {}) {
  const known = context.all.filter(row => row.id === id);
  if (!known.length) return null;
  const running = context.runningFor(id), desired = context.desiredFor(id);
  const sourceIds = [...new Set(known.map(sourceOf).filter(Boolean))].sort(textOrder);
  const owner = running || desired;
  const viewedSource = sourceId || sourceOf(owner) || (sourceIds.length === 1 ? sourceIds[0] : '');
  const releaseSourceId = owner ? sourceOf(owner) : viewedSource;
  // Running and selected snapshots remain inspectable after directory removal.
  // Only actual directory entries establish the latest published release.
  const versions = known.filter(row => !viewedSource || sourceOf(row) === viewedSource)
    .filter((row, index, rows) => rows.findIndex(other => sameTarget(other, row)) === index);
  const latestFor = source => sourceIsAvailable(context.data, source)
    ? context.catalog.filter(row => row.id === id && sourceOf(row) === source && versionIsValid(row.version)).sort(rowOrder)[0] || null
    : null;
  const latest = latestFor(releaseSourceId), viewLatest = latestFor(viewedSource);
  const row = version
    ? (viewedSource ? [running, desired, ...versions].find(candidate => candidate && sourceOf(candidate) === viewedSource && candidate.version === version) || null : null)
    : running || desired || viewLatest || versions[0] || null;
  const update = running && sourceIsAvailable(context.data, releaseSourceId)
    ? context.catalog.filter(candidate => candidate.id === id && sourceOf(candidate) === releaseSourceId)
      .sort(rowOrder).find(candidate => candidateState(context, candidate, { includeSelected: true }).available) || null
    : null;
  return { id, running, desired,
    pending: rowsOf(context.data?.pending).find(change => change.id === id) || null,
    sourceIds, sourceId: viewedSource, releaseSourceId,
    latest, viewLatest, versions, row, update,
    sourceAvailable: sourceIsAvailable(context.data, viewedSource),
    ambiguousSource: !owner && !sourceId && sourceIds.length > 1 };
}

/** One outer entry per stable ID. A source filter never changes ownership. */
export function catalogGroups(data, { sourceId = '', installedOnly = false } = {}) {
  const context = catalogContext(data);
  return [...new Set(context.all.map(row => row.id))].sort(textOrder)
    .map(id => pluginModel(context, id, { sourceId }))
    .filter(model => (!sourceId || model.sourceIds.includes(sourceId)) && (!installedOnly || model.running));
}

/** Exact source/version deep links return a missing row instead of another package. */
export function catalogPlugin(data, id, options = {}) {
  return pluginModel(catalogContext(data), id, options);
}
