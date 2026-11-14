import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogCandidateState, catalogGroups, catalogPlugin, catalogVersionAvailability, sameCatalogTarget, catalogTargetKey } from './catalog.js';
import { HOST_PLUGIN_API_VERSION } from '../../../shared/plugins/manifest.js';

const row = (id, version, sourceId = 'official', extra = {}) => ({
  id, version, sourceId, sourceName: sourceId,
  manifest: { id, version, hostApiVersion: 1, apiVersion: 1, name: `${id} ${sourceId}`,
    description: 'Catalog fixture', icon: 'box', pages: [], entries: [], ...extra },
  source: sourceId === 'workspace' ? { type: 'workspace', id: sourceId, sourceDigest: 'a'.repeat(64) }
    : { type: 'artifact', id: sourceId, url: `https://packages.example.org/${id}/${version}.js`, sha256: 'b'.repeat(64) },
});
const data = (catalog = [], running = [], desired = running, extra = {}) => ({
  catalog, running, desired, pending: [], sources: [{ id: 'official', status: 'ready' }, { id: 'other', status: 'ready' }], ...extra,
});
const ids = rows => rows.map(item => `${item.sourceId}:${item.version}`);

test('exact package identities distinguish republished artifacts and preserve known snapshots in old deep links', () => {
  const current = row('player', '1.0.0');
  const republished = { ...current, source: { ...current.source, sha256: 'c'.repeat(64) } };
  const state = data([republished], [current]);
  const model = catalogPlugin(state, 'player', { sourceId: 'official', version: '1.0.0' });
  assert.equal(model.row, current);
  assert.equal(model.latest, republished);
  assert.equal(model.versions.length, 2);
  assert.equal(sameCatalogTarget(current, republished), false);
  assert.notEqual(catalogTargetKey(current), catalogTargetKey(republished));
  assert.equal(catalogCandidateState(state, republished).available, false);
});

test('one group per stable ID sorts releases numerically and separates current from latest', () => {
  const current = row('player', '1.9.9');
  const releases = [row('player', '1.0.12'), row('player', '1.10.0'), current, row('player', '1.0.2'), row('another', '2.0.0')];
  const models = catalogGroups(data(releases, [current]));
  assert.deepEqual(models.map(model => model.id), ['another', 'player']);
  const model = models[1];
  assert.equal(model.running, current);
  assert.equal(model.row, current);
  assert.equal(model.latest.version, '1.10.0');
  assert.equal(model.update.version, '1.10.0');
  assert.deepEqual(ids(model.versions), ['official:1.10.0', 'official:1.9.9', 'official:1.0.12', 'official:1.0.2']);
});

test('older and equal versions never become ordinary updates; an exact new package can be installed', () => {
  const current = row('player', '2.0.0'), older = row('player', '1.10.0'), newer = row('player', '2.0.1');
  const state = data([older, current, newer], [current]);
  assert.deepEqual(catalogCandidateState(state, current), { operation: null, available: false, reason: 'current' });
  assert.deepEqual(catalogCandidateState(state, older), { operation: null, available: false, reason: 'not_newer' });
  assert.deepEqual(catalogCandidateState(state, newer), { operation: 'update', available: true, reason: null });
  assert.deepEqual(catalogCandidateState(data([current]), current), { operation: 'install', available: true, reason: null });
});

test('pending updates lock the selected target without presenting it as the running version', () => {
  const current = row('player', '1.0.0'), middle = row('player', '1.5.0'), selected = row('player', '2.0.0');
  const newest = row('player', '3.0.0', 'official', { hostApiVersion: HOST_PLUGIN_API_VERSION + 1 });
  const pending = { id: 'player', operation: 'update', fromVersion: '1.0.0', toVersion: '2.0.0' };
  const state = data([newest, middle, selected, current], [current], [selected], { pending: [pending] });
  const model = catalogPlugin(state, 'player');
  assert.equal(model.running.version, '1.0.0');
  assert.equal(model.desired, selected);
  assert.equal(model.pending, pending);
  assert.equal(model.latest, newest, 'the actual latest release is still shown when incompatible');
  assert.equal(model.update, selected, 'the highest compatible release may equal the already selected target');
  assert.equal(catalogCandidateState(state, selected).reason, 'selected');
  assert.equal(catalogCandidateState(state, middle).reason, 'not_newer');
  assert.equal(catalogCandidateState(state, newest).reason, 'host_incompatible');
});

test('a pending first install retains its source and does not count as installed', () => {
  const selected = row('player', '2.0.0', 'other'), higher = row('player', '3.0.0', 'other');
  const foreign = row('player', '9.0.0');
  const state = data([foreign, higher, selected, row('player', '1.0.0', 'other')], [], [selected],
    { pending: [{ id: 'player', operation: 'install' }] });
  const model = catalogPlugin(state, 'player');
  assert.equal(model.running, null);
  assert.equal(model.row, selected);
  assert.equal(model.releaseSourceId, 'other');
  assert.equal(model.latest, higher);
  assert.equal(model.ambiguousSource, false);
  assert.equal(model.update, null);
  assert.deepEqual(catalogGroups(state, { installedOnly: true }), []);
  assert.equal(catalogCandidateState(state, foreign).reason, 'source_conflict');
  assert.equal(catalogCandidateState(state, higher).operation, 'install');
  assert.equal(catalogCandidateState(state, state.catalog.at(-1)).reason, 'not_newer');
});

test('a source filter keeps installed identity and release ownership on the original source', () => {
  const current = row('player', '1.0.0'), ownedLatest = row('player', '2.0.0'), foreign = row('player', '9.0.0', 'other');
  const state = data([foreign, ownedLatest, current, row('other-plugin', '1.0.0')], [current]);
  const [model] = catalogGroups(state, { sourceId: 'other' });
  assert.equal(model.id, 'player');
  assert.equal(model.sourceId, 'other');
  assert.equal(model.releaseSourceId, 'official');
  assert.equal(model.row, current);
  assert.equal(model.latest, ownedLatest);
  assert.equal(model.viewLatest, foreign);
  assert.equal(model.update, ownedLatest);
  assert.deepEqual(model.sourceIds, ['official', 'other']);
  assert.deepEqual(ids(model.versions), ['other:9.0.0']);
  assert.equal(catalogCandidateState(state, foreign).reason, 'source_conflict');
});

test('uninstalled all-source groups do not invent one global latest or choose a release source', () => {
  const state = data([row('player', '2.0.0'), row('player', '9.0.0', 'other')]);
  const model = catalogPlugin(state, 'player');
  assert.equal(model.ambiguousSource, true);
  assert.equal(model.sourceId, '');
  assert.equal(model.releaseSourceId, '');
  assert.equal(model.latest, null);
  assert.equal(model.viewLatest, null);
  assert.equal(model.sourceAvailable, false);
  assert.equal(model.versions.length, 2);
  assert.equal(catalogPlugin(state, 'player', { version: '9.0.0' }).row, null, 'a version alone cannot silently select one of multiple sources');
  const explicit = catalogPlugin(state, 'player', { sourceId: 'official' });
  assert.equal(explicit.ambiguousSource, false);
  assert.equal(explicit.latest.version, '2.0.0');
  assert.equal(explicit.row.sourceId, 'official');
});

test('a unique uninstalled source supplies its own latest release', () => {
  const state = data([row('player', '2.0.0'), row('player', '1.0.0')]);
  const model = catalogPlugin(state, 'player');
  assert.equal(model.sourceId, 'official');
  assert.equal(model.latest.version, '2.0.0');
  assert.equal(model.row, model.latest);
  assert.equal(model.ambiguousSource, false);
});

test('failed, unpublished and removed remote sources retain readonly versions but cannot establish latest or actions', () => {
  const current = row('player', '1.0.0'), newer = row('player', '2.0.0');
  for (const sources of [[], [{ id: 'official', status: 'error' }], [{ id: 'official', status: 'unpublished' }]]) {
    const state = data([newer], [current], [current], { sources });
    const model = catalogPlugin(state, 'player');
    assert.equal(model.row, current);
    assert.equal(model.sourceAvailable, false);
    assert.equal(model.latest, null);
    assert.equal(model.viewLatest, null);
    assert.equal(model.update, null);
    assert.deepEqual(ids(model.versions), ['official:2.0.0', 'official:1.0.0']);
    assert.equal(catalogCandidateState(state, newer).reason, 'source_unavailable');
    assert.equal(catalogPlugin(state, 'player', { sourceId: 'official', version: '1.0.0' }).row, current);
  }
});

test('workspace packages stay available without a remote source record', () => {
  const current = row('player', '1.0.0', 'workspace'), newer = row('player', '1.0.1', 'workspace');
  const state = data([newer], [current], [current], { sources: [] });
  assert.equal(catalogPlugin(state, 'player').latest, newer);
  assert.equal(catalogCandidateState(state, newer).available, true);
});

test('exact deep links use known running and desired snapshots, and missing versions never substitute a package', () => {
  const current = row('player', '1.0.0'), selected = row('player', '2.0.0');
  const state = data([row('player', '3.0.0')], [current], [selected]);
  assert.equal(catalogPlugin(state, 'player', { sourceId: 'official', version: '1.0.0' }).row, current);
  assert.equal(catalogPlugin(state, 'player', { sourceId: 'official', version: '2.0.0' }).row, selected);
  assert.equal(catalogPlugin(state, 'player', { sourceId: 'official', version: '0.9.0' }).row, null);
  assert.equal(catalogPlugin(state, 'player', { sourceId: 'other', version: '1.0.0' }).row, null);
  assert.equal(catalogPlugin(state, 'missing'), null);
  assert.deepEqual(catalogGroups(state, { sourceId: 'missing' }), []);
});

test('an installed snapshot survives directory removal without pretending that snapshot is latest', () => {
  const current = row('player', '1.0.0');
  const state = data([], [current]);
  const [model] = catalogGroups(state, { installedOnly: true });
  assert.equal(model.row, current);
  assert.equal(model.latest, null);
  assert.equal(model.update, null);
  assert.deepEqual(model.versions, [current]);
});

test('compatibility checks the entire desired combination, including dependents of an updated provider', () => {
  const provider = row('provider', '1.0.0'), safe = row('provider', '1.5.0');
  const latest = row('provider', '2.0.0', 'official', { apiVersion: 2 });
  const consumer = row('consumer', '1.0.0', 'official', { dependencies: { provider: { apiVersion: 1, version: '^1.0.0' } } });
  const state = data([provider, safe, latest, consumer], [provider, consumer]);
  const model = catalogPlugin(state, 'provider');
  assert.equal(model.latest, latest);
  assert.equal(model.update, safe);
  assert.equal(catalogCandidateState(state, latest).reason, 'incompatible_dependency');
  const nextConsumer = row('consumer', '2.0.0', 'official', { dependencies: { provider: { apiVersion: 2, version: '^2.0.0' } } });
  const pendingCombination = data([provider, safe, latest, nextConsumer], [provider, consumer], [provider, nextConsumer]);
  assert.equal(catalogCandidateState(pendingCombination, latest).available, true, 'compatibility uses selected targets, not stale running dependents');
});

test('optional dependencies do not block installation or compatible provider replacement', () => {
  const optional = row('consumer', '1.0.0', 'official', { optionalDependencies: { provider: { apiVersion: 1, features: ['ai'] } } });
  assert.equal(catalogCandidateState(data([optional]), optional).available, true);
  const provider = row('provider', '1.0.0'), latest = row('provider', '2.0.0', 'official', { apiVersion: 2 });
  const state = data([provider, latest, optional], [provider, optional]);
  assert.equal(catalogCandidateState(state, latest).available, true, 'a disabled optional feature is not a broken required dependent');
  assert.equal(catalogPlugin(state, 'provider').update, latest);
});

test('missing required dependencies, incompatible hosts and malformed manifests never enable a candidate', () => {
  const missing = row('consumer', '1.0.0', 'official', { dependencies: { provider: { apiVersion: 1 } } });
  assert.equal(catalogCandidateState(data([missing]), missing).reason, 'missing_dependency');
  const future = row('player', '2.0.0', 'official', { hostApiVersion: HOST_PLUGIN_API_VERSION + 1 });
  assert.equal(catalogCandidateState(data([future]), future).reason, 'host_incompatible');
  const invalid = row('player', '3.0.0', 'official', { pages: 'not-an-array' });
  const state = data([invalid]);
  assert.equal(catalogPlugin(state, 'player').latest, invalid, 'published version reporting is separate from compatibility');
  assert.equal(catalogCandidateState(state, invalid).reason, 'invalid_manifest');
  const mismatched = { ...row('player', '1.0.0'), version: '2.0.0' };
  assert.equal(catalogCandidateState(data([mismatched]), mismatched).reason, 'invalid_manifest');
});

test('malformed selected manifests cannot be hidden by validating only the candidate', () => {
  const selected = row('broken', '1.0.0', 'official', { apiVersion: 0 }), candidate = row('player', '1.0.0');
  assert.equal(catalogCandidateState(data([candidate], [], [selected]), candidate).reason, 'invalid_manifest');
});

test('same-version republished packages and targets below a pending first install stay unavailable', () => {
  const current = row('player', '1.0.0'), republished = { ...current, source: { ...current.source, sha256: 'c'.repeat(64) } };
  assert.equal(catalogCandidateState(data([republished], [current]), republished).reason, 'not_newer');
  assert.equal(catalogCandidateState(data([republished], [], [current]), republished).reason, 'not_newer');
  const unlisted = row('player', '2.0.0');
  assert.equal(catalogCandidateState(data([current], [current]), unlisted).reason, 'not_found');
});

test('invalid version strings remain readonly and cannot outrank valid published releases', () => {
  const valid = row('player', '1.10.0');
  for (const version of ['1.02.3', '1.2', 'v9.0.0', '2.0.0-beta', '9007199254740992.0.0']) {
    const invalid = row('player', version), state = data([invalid, valid]);
    assert.equal(catalogCandidateState(state, invalid).available, false);
    assert.equal(catalogPlugin(state, 'player').latest, valid);
    assert.equal(catalogPlugin(state, 'player').versions.at(-1), invalid);
  }
});

test('directory order never changes grouping, source choice, release ordering or pending ownership', () => {
  const current = row('player', '1.0.0'), selected = row('new-plugin', '1.2.0', 'other');
  const catalog = [row('player', '1.10.0'), row('player', '1.2.0'), row('player', '9.0.0', 'other'), current,
    selected, row('new-plugin', '1.5.0', 'other'), row('new-plugin', '8.0.0')];
  const initial = data(catalog, [current], [current, selected]);
  const expected = catalogGroups(initial);
  for (let shift = 0; shift < catalog.length; shift++) {
    const shuffled = [...catalog.slice(shift), ...catalog.slice(0, shift)].reverse();
    assert.deepEqual(catalogGroups({ ...initial, catalog: shuffled, sources: [...initial.sources].reverse(), desired: [...initial.desired].reverse() }), expected);
  }
});

test('model reads do not mutate frozen input and pending removals retain actual ownership', () => {
  const current = row('player', '1.0.0'), next = row('player', '2.0.0');
  const pending = { id: 'player', operation: 'uninstall' };
  const state = data([next], [current], [], { pending: [pending] });
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(state);
  const model = catalogGroups(state)[0];
  assert.equal(model.running, current);
  assert.equal(model.desired, null);
  assert.equal(model.pending, pending);
  assert.equal(model.releaseSourceId, 'official');
  assert.equal(catalogCandidateState(state, next).available, true);
  assert.deepEqual(catalogGroups(null), []);
});

test('historical compatibility is reported independently from older-version and source action restrictions', () => {
  const current = row('player', '2.0.0');
  const older = row('player', '1.0.0', 'official', { hostApiVersion: HOST_PLUGIN_API_VERSION + 1 });
  const foreign = row('player', '1.5.0', 'other');
  const state = data([older, foreign], [current], [current], { sources: [] });
  assert.equal(catalogCandidateState(state, older).reason, 'not_newer');
  assert.deepEqual(catalogVersionAvailability(state, older), { available: false, reason: 'host_incompatible' });
  assert.equal(catalogCandidateState(state, foreign).reason, 'source_conflict');
  assert.deepEqual(catalogVersionAvailability(state, foreign), { available: true, reason: null });
});

test('historical compatibility checks the replacement against all desired dependents without requiring optional features', () => {
  const current = row('provider', '2.0.0', 'official', { apiVersion: 2 });
  const older = row('provider', '1.0.0', 'other');
  const required = row('consumer', '1.0.0', 'official', { dependencies: { provider: { apiVersion: 2 } } });
  assert.deepEqual(catalogVersionAvailability(data([], [current, required]), older), { available: false, reason: 'incompatible_dependency' });
  const optional = row('consumer', '1.0.0', 'official', { optionalDependencies: { provider: { apiVersion: 2, features: ['ai'] } } });
  assert.deepEqual(catalogVersionAvailability(data([], [current, optional]), older), { available: true, reason: null });
});

test('version compatibility strictly validates the exact row and manifest before reporting compatibility', () => {
  const valid = row('player', '1.0.0');
  for (const invalid of [null, { ...valid, id: 'different' }, { ...valid, version: '1.0.1' },
    row('player', '01.0.0'), row('player', '1.0.0', 'official', { pages: 'invalid' })]) {
    assert.deepEqual(catalogVersionAvailability(data([valid]), invalid), { available: false, reason: 'invalid_manifest' });
  }
});
