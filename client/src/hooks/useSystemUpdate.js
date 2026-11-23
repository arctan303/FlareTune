import { useCallback, useEffect, useRef, useState } from 'react';
import { systemUpdateRequest, systemUpdateErrorMessage, recheckSystemUpdateStatus } from '../services/systemUpdate.js';
import { isDemoRuntime } from '../services/runtimeFetch.js';
import { ACTIVE_PLUGIN_BUILDS } from '../../../shared/plugins/delivery.js';

const running = new Set(['queued', 'building', 'backup', 'uploaded', 'deploying', 'migrating', 'verifying', 'activation_pending', 'rolling_back']);
export const activeSystemUpdate = job => running.has(job?.status);
export const retryableSystemUpdate = job => job?.resumable !== false
  && (['failed', 'activation_pending'].includes(job?.status) || activeSystemUpdate(job) && job?.resumable === true);
export const activePluginUpdate = build => ACTIVE_PLUGIN_BUILDS.has(build?.status) && !build?.resultUnknown;
const verificationKey = job => job?.taskId
  ? JSON.stringify([job.taskId, job.providerBuildId, job.status, job.updatedAt, job.receipt?.nextVersionId,
    job.receipt?.uploadStarted, job.receipt?.migrationCompleted]) : '';
const subject = session => !isDemoRuntime && session?.authenticated && !session.mustChangePassword && session.user?.role === 'admin'
  ? JSON.stringify([session.user.accountId, session.csrfToken]) : '';

export function useSystemUpdate(session) {
  const owner = subject(session);
  const current = useRef(owner); current.current = owner;
  const controller = useRef(null), pending = useRef(false), sequence = useRef(0), dataRef = useRef(null);
  const verificationRequest = useRef(null);
  const [state, setState] = useState({ owner: '', data: null, loading: false, busy: false, error: '' });
  const [verification, setVerification] = useState(null);
  const refresh = useCallback(async () => {
    if (!owner || current.current !== owner || pending.current) return null;
    const serial = ++sequence.current, signal = controller.current?.signal;
    setState(previous => ({ ...previous, owner, loading: true }));
    try {
      const data = await systemUpdateRequest(session, '', { signal });
      if (current.current !== owner || signal?.aborted || serial !== sequence.current) return null;
      dataRef.current = data;
      setState(previous => ({ ...previous, owner, data, loading: false, error: '' }));
      return data;
    } catch (error) {
      if (error?.status === 503) await recheckSystemUpdateStatus({ signal,
        isCurrent: () => current.current === owner && controller.current?.signal === signal });
      if (current.current === owner && !signal?.aborted && serial === sequence.current) {
        setState(previous => ({ ...previous, owner, loading: false, error: systemUpdateErrorMessage(error) }));
      }
      return null;
    }
  }, [owner]);
  useEffect(() => {
    controller.current = new AbortController(); pending.current = false; dataRef.current = null;
    verificationRequest.current = null;
    setState({ owner, data: null, loading: !!owner, busy: false, error: '' });
    setVerification(null);
    void refresh();
    return () => { controller.current?.abort(); ++sequence.current; };
  }, [owner, refresh]);
  const action = useCallback(async (path = '', method = 'POST', body = {}) => {
    if (!owner || current.current !== owner || pending.current || !dataRef.current) return null;
    pending.current = true; ++sequence.current;
    verificationRequest.current = null;
    setVerification(null);
    const signal = controller.current?.signal;
    const revision = dataRef.current.revision;
    setState(previous => ({ ...previous, busy: true, error: '' }));
    try {
      const data = await systemUpdateRequest(session, path, { method, body: { ...body, revision }, signal });
      if (current.current !== owner || signal?.aborted) return null;
      dataRef.current = data;
      setState({ owner, data, busy: false, loading: false, error: '' });
      return data;
    } catch (error) {
      if (error?.status === 503) await recheckSystemUpdateStatus({ signal,
        isCurrent: () => current.current === owner && controller.current?.signal === signal });
      if (current.current === owner && !signal?.aborted) {
        // A failed response may follow a committed task. Read its actual state
        // before exposing retry, without clearing the useful failure message.
        let data = dataRef.current;
        try { data = await systemUpdateRequest(session, '', { signal }); } catch { /* Keep the last confirmed state. */ }
        if (current.current !== owner || signal?.aborted) return null;
        dataRef.current = data;
        setState(previous => ({ ...previous, data, busy: false, loading: false, error: systemUpdateErrorMessage(error) }));
      }
      return null;
    } finally {
      if (current.current === owner && controller.current?.signal === signal) pending.current = false;
    }
  }, [owner]);
  const verify = useCallback(async taskId => {
    const data = dataRef.current, key = verificationKey(data?.job);
    if (!owner || current.current !== owner || pending.current || !key || data.job.taskId !== taskId
      || verificationRequest.current?.key === key) return null;
    const signal = controller.current?.signal, request = { key };
    verificationRequest.current = request;
    const applies = () => verificationRequest.current === request && current.current === owner && !signal?.aborted
      && key === verificationKey(dataRef.current?.job);
    setVerification({ owner, key, busy: true });
    try {
      const result = await systemUpdateRequest(session, '/verify', { method: 'POST', body: { revision: data.revision, taskId }, signal });
      if (!applies()) return null;
      if (result?.taskId !== taskId || result.providerBuildId && result.providerBuildId !== data.job.providerBuildId) {
        setVerification({ owner, key, error: '更新任务已变化，请刷新后核实。' });
        return null;
      }
      setVerification({ owner, key, result });
      return result;
    } catch (error) {
      if (applies()) setVerification({ owner, key, error: systemUpdateErrorMessage(error) });
      return null;
    } finally {
      if (verificationRequest.current === request) verificationRequest.current = null;
    }
  }, [owner]);
  const data = state.owner === owner && owner ? state.data : null;
  const pluginBuild = data?.pluginUpdates?.build;
  const waitingForPlugins = data?.job?.status === 'deployed' && data.job.followUp?.status === 'waiting';
  const shouldPoll = activeSystemUpdate(data?.job) || activePluginUpdate(pluginBuild) || waitingForPlugins;
  useEffect(() => {
    if (!owner || !shouldPoll) return;
    const timer = setInterval(() => { void refresh(); }, 4000);
    return () => clearInterval(timer);
  }, [owner, shouldPoll, refresh]);
  return { data, loading: state.owner !== owner ? !!owner : state.loading,
    busy: state.owner === owner && state.busy, error: state.owner === owner ? state.error : '',
    verification: verification?.owner === owner && verification.key === verificationKey(data?.job) ? verification : null,
    demo: isDemoRuntime, refresh, action, verify };
}
