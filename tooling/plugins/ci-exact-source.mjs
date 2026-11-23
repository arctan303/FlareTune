import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRelease } from '../../server/src/systemUpdate/releases.js';
import { downloadSource, extractSourceArchive } from '../updates/archive.mjs';
import { verifySourceCheckout } from '../updates/bootstrap.mjs';
import { fetchDeliveryWireSnapshot } from './delivery.mjs';
import { readPluginOwnedFile, writePluginOwnedFile } from './assemble.mjs';

const recoveryDirectory = 'tooling/plugins/.delivery-recovery';
const marker = `${recoveryDirectory}/ci-source.json`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sameHost = (a, b) => Boolean(a && b && a.version === b.version && a.sourceDigest === b.sourceDigest);
const prepareStatuses = new Set(['triggering', 'queued', 'building']);

export function classifyPluginCiSnapshot(snapshot) {
  // A delayed hook for a missing or completed task must not reserve a host
  // upgrade. Maintain the old command only for explicit active upgrade jobs.
  if (!snapshot) return 'idle';
  if (snapshot.kind !== undefined && snapshot.kind !== 'host-upgrade') fail('PLUGIN_SNAPSHOT_INVALID');
  if (snapshot.buildStatus === 'deployed') return 'idle';
  if (!prepareStatuses.has(snapshot.buildStatus)) fail('PLUGIN_DEPLOYMENT_UNCONFIRMED');
  return snapshot.kind === 'host-upgrade' ? 'legacy' : 'plugin';
}

export function exactHostRelease(snapshot) {
  if (snapshot.hostRelease === undefined) return null;
  let release;
  try { release = validateRelease(snapshot.hostRelease, { channel: snapshot.hostRelease?.channel }); }
  catch { fail('PLUGIN_CI_SOURCE_INVALID'); }
  if (!sameHost(release.host, snapshot.host)) fail('PLUGIN_CI_SOURCE_INVALID');
  return release;
}

function assertSamePlan(current, expected) {
  if (!current || current.buildId !== expected.buildId || current.planDigest !== expected.planDigest || !sameHost(current.host, expected.host)) {
    fail('PLUGIN_BUILD_SUPERSEDED');
  }
}

export function pinPluginBuildFetch(connection, expected, fetchImpl = fetch, fetchSnapshot = fetchDeliveryWireSnapshot) {
  const endpoint = `${connection.origin}/api/plugin-build/snapshot`;
  const upgrade = `${connection.origin}/api/plugin-build/upgrade`;
  return async (input, options) => {
    // prepare-current can reserve a host upgrade on its own. Allow it to
    // resume the frozen upgrade only, even if its GET saw a newer state.
    if (String(input) === upgrade && options?.method === 'POST') fail('PLUGIN_BUILD_SUPERSEDED');
    if (String(input) !== endpoint) return fetchImpl(input, options);
    const live = await fetchSnapshot(connection, { fetchImpl });
    assertSamePlan(live, expected);
    return Response.json(live);
  };
}

async function sourceDirectory(root, create = false) {
  let path = await realpath(root);
  for (const segment of recoveryDirectory.split('/')) {
    path = resolve(path, segment);
    try {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('PLUGIN_OUTPUT_PATH_INVALID');
    } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      await mkdir(path);
    }
  }
  if (await realpath(path) !== path) fail('PLUGIN_OUTPUT_PATH_INVALID');
  return path;
}

export async function stageExactPluginSource(root, release, { fetchImpl = fetch } = {}) {
  const bytes = await downloadSource(release, { fetchImpl });
  const directory = await sourceDirectory(root, true);
  const checkout = await mkdtemp(resolve(directory, 'ci-host-'));
  await extractSourceArchive(bytes, release.commit, checkout);
  await verifySourceCheckout(checkout, release);
  return checkout;
}

export async function saveExactPluginSource(root, checkout, snapshot, release) {
  const directory = await sourceDirectory(root);
  const name = basename(checkout);
  if (!/^ci-host-[a-zA-Z0-9]{6}$/.test(name) || resolve(directory, name) !== await realpath(checkout)) fail('PLUGIN_OUTPUT_PATH_INVALID');
  await writePluginOwnedFile(root, marker, JSON.stringify({ schemaVersion: 1, name, buildId: snapshot.buildId,
    planDigest: snapshot.planDigest, host: snapshot.host, commit: release.commit, archiveSha256: release.source.sha256 }));
}

export async function saveIdlePluginBuild(root, snapshot) {
  await writePluginOwnedFile(root, marker, JSON.stringify({ schemaVersion: 1, idle: true, buildId: snapshot?.buildId ?? null,
    planDigest: snapshot?.planDigest, host: snapshot?.host }));
}

export async function readExactPluginSource(root, connection, { fetchImpl = fetch, fetchSnapshot = fetchDeliveryWireSnapshot } = {}) {
  let bytes;
  try { bytes = await readPluginOwnedFile(root, marker, 4096); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let saved;
  try { saved = JSON.parse(bytes.toString('utf8')); }
  catch { fail('PLUGIN_CI_SOURCE_INVALID'); }
  if (saved?.schemaVersion !== 1 || (saved.idle !== true && !/^ci-host-[a-zA-Z0-9]{6}$/.test(saved.name || ''))) fail('PLUGIN_CI_SOURCE_INVALID');
  const snapshot = await fetchSnapshot(connection, { fetchImpl });
  if (saved.idle === true) {
    if (saved.buildId === null && snapshot === null) return { idle: true };
    assertSamePlan(snapshot, saved);
    if (classifyPluginCiSnapshot(snapshot) !== 'idle') fail('PLUGIN_BUILD_SUPERSEDED');
    return { idle: true };
  }
  assertSamePlan(snapshot, saved);
  const release = exactHostRelease(snapshot);
  if (!release || release.commit !== saved.commit || release.source.sha256 !== saved.archiveSha256) fail('PLUGIN_CI_SOURCE_INVALID');
  const directory = await sourceDirectory(root), checkout = resolve(directory, saved.name);
  const info = await lstat(checkout);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(checkout) !== checkout) fail('PLUGIN_OUTPUT_PATH_INVALID');
  await verifySourceCheckout(checkout, release);
  return { checkout, snapshot };
}

export function loadExactPluginTool(checkout, file) {
  // Callers pass only fixed tooling paths, after verifying the official source
  // archive and host identity. Never load a package module here.
  return import(pathToFileURL(resolve(checkout, file)).href);
}
