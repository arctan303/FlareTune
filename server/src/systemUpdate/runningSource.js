import { canonical } from './common.js';
import { validateRelease } from './releases.js';

export function releaseForRunningHost(state, host) {
  const lastCompleted = state.job?.status === 'deployed' && state.job.receipt?.migrationCompleted === true
    ? state.job.target : null;
  for (const value of [state.runningRelease, lastCompleted]) {
    if (!value || !host || canonical(value.host) !== canonical(host)) continue;
    try { return validateRelease(value, { channel: value.channel }); }
    catch { /* A broken or obsolete source cannot identify this checkout. */ }
  }
  return null;
}
