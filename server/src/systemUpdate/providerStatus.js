import { canonical, uuid } from './common.js';
import { boundedJson } from './releases.js';

const accountIdValid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const workerNameValid = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
const sameVersions = (left, right) => canonical([...left].sort((a, b) => a.version_id.localeCompare(b.version_id)))
  === canonical([...right].sort((a, b) => a.version_id.localeCompare(b.version_id)));

function deploymentVersion(value) {
  if (!uuid(value?.id) || value.strategy !== 'percentage' || !Array.isArray(value.versions) || value.versions.length < 1
    || value.versions.length > 8 || value.versions.some(row => !uuid(row?.version_id) || typeof row.percentage !== 'number'
      || !Number.isFinite(row.percentage) || row.percentage <= 0 || row.percentage > 100)
    || new Set(value.versions.map(row => row.version_id)).size !== value.versions.length
    || Math.abs(value.versions.reduce((sum, row) => sum + row.percentage, 0) - 100) > 0.0001) return null;
  return { id: value.id, versions: value.versions.map(({ version_id, percentage }) => ({ version_id, percentage })) };
}

export async function readSystemUpdateProviderStatus(env, job, { fetchImpl = fetch } = {}) {
  const receipt = job.receipt;
  const accountId = env.FLARETUNE_UPDATE_STATUS_ACCOUNT_ID ?? receipt?.accountId;
  const workerName = env.FLARETUNE_UPDATE_STATUS_WORKER_NAME ?? receipt?.workerName;
  const providerBuildId = uuid(job.providerBuildId) ? job.providerBuildId : null;
  const targetKnown = accountIdValid(accountId) && workerNameValid(workerName)
    && (!receipt || receipt.accountId === accountId && receipt.workerName === workerName);
  const base = { taskId: job.taskId, providerBuildId,
    ...(providerBuildId && targetKnown ? {
      buildUrl: `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}/production/builds/${providerBuildId}`,
    } : {}) };
  const wait = reason => ({ ...base, status: 'awaiting_verification', reason });
  if (!targetKnown) return wait('target_unavailable');
  const token = env.FLARETUNE_UPDATE_STATUS_TOKEN;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) return wait('status_access_unconfigured');

  const signal = AbortSignal.timeout(8000);
  const read = async path => {
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
        method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'manual', credentials: 'omit', signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { reason: [401, 403].includes(response.status) ? 'status_access_denied' : 'provider_unavailable' };
      }
      const body = await boundedJson(response, 2 * 1024 * 1024);
      return body.success === true ? { result: body.result } : { reason: 'provider_unavailable' };
    } catch { return { reason: 'provider_unavailable' }; }
  };

  if (!receipt?.uploadStarted) {
    if (!providerBuildId) return wait('build_identity_unavailable');
    const build = await read(`/builds/builds/${providerBuildId}`);
    if (build.reason) return wait(build.reason);
    if (build.result?.build_uuid !== providerBuildId) return wait('build_identity_mismatch');
    if (['queued', 'initializing', 'running'].includes(build.result.status)) {
      return { ...base, status: 'build_in_progress', reason: 'provider_build_running' };
    }
    if (!job.execution && !receipt && job.status === 'queued' && build.result.status === 'stopped'
      && ['fail', 'cancelled', 'terminated', 'skipped'].includes(build.result.build_outcome)) {
      return { ...base, status: 'pre_claim_failed', reason: 'provider_build_stopped' };
    }
    return wait('task_result_unconfirmed');
  }

  const path = `/workers/scripts/${workerName}`;
  const [uploaded, deployed] = await Promise.all([read(`${path}/versions?per_page=100`), read(`${path}/deployments?per_page=1`)]);
  if (uploaded.reason || deployed.reason) return wait(uploaded.reason || deployed.reason);
  if (!Array.isArray(uploaded.result?.items)) return wait('provider_unavailable');
  const matching = uploaded.result.items.filter(row => row?.annotations?.['workers/tag'] === `system-${job.taskId}`);
  if (matching.length > 1 || matching.some(row => !uuid(row.id))) return wait('upload_ambiguous');
  const versionId = matching[0]?.id;
  if (!versionId) return wait('upload_not_visible');
  if (receipt.nextVersionId && receipt.nextVersionId !== versionId) return wait('upload_identity_mismatch');
  const current = deploymentVersion(deployed.result?.deployments?.[0]);
  if (!current) return wait('provider_unavailable');
  if (current.versions.length === 1 && current.versions[0].version_id === versionId && current.versions[0].percentage === 100) {
    return { ...base, status: 'deployment_confirmed', reason: 'target_version_serving', nextVersionId: versionId, deploymentVersion: versionId };
  }
  const previous = deploymentVersion(receipt.previous);
  if (!previous || current.id !== previous.id || !sameVersions(current.versions, previous.versions)) return wait('deployment_changed');
  return { ...base, status: 'upload_confirmed', reason: 'tagged_version_found', nextVersionId: versionId };
}
