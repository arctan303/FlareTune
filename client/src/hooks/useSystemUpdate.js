import { useCallback, useEffect, useRef, useState } from 'react';
import { systemUpdateRequest, systemUpdateErrorMessage, recheckSystemUpdateStatus } from '../services/systemUpdate.js';
import { isDemoRuntime } from '../services/runtimeFetch.js';

const running = new Set(['queued', 'building', 'backup', 'uploaded', 'deploying', 'migrating', 'verifying', 'activation_pending', 'rolling_back']);
export const activeSystemUpdate = job => running.has(job?.status);
export const retryableSystemUpdate = job => ['failed', 'activation_pending'].includes(job?.status)
  || activeSystemUpdate(job) && job?.resumable === true;
const subject = session => !isDemoRuntime && session?.authenticated && !session.mustChangePassword && session.user?.role === 'admin'
  ? JSON.stringify([session.user.accountId, session.csrfToken]) : '';

export function useSystemUpdate(session) {
  const owner = subject(session);
  const current = useRef(owner); current.current = owner;
  const controller = useRef(null), pending = useRef(false), sequence = useRef(0), dataRef = useRef(null);
  const [state, setState] = useState({ owner: '', data: null, loading: false, busy: false, error: '' });
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
    setState({ owner, data: null, loading: !!owner, busy: false, error: '' });
    void refresh();
    return () => { controller.current?.abort(); ++sequence.current; };
  }, [owner, refresh]);
  const action = useCallback(async (path = '', method = 'POST', body = {}) => {
    if (!owner || current.current !== owner || pending.current || !dataRef.current) return null;
    pending.current = true; ++sequence.current;
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
  const data = state.owner === owner && owner ? state.data : null;
  useEffect(() => {
    if (!owner || !activeSystemUpdate(data?.job)) return;
    const timer = setInterval(() => { void refresh(); }, 4000);
    return () => clearInterval(timer);
  }, [owner, data?.job?.status, refresh]);
  return { data, loading: state.owner !== owner ? !!owner : state.loading,
    busy: state.owner === owner && state.busy, error: state.owner === owner ? state.error : '',
    demo: isDemoRuntime, refresh, action };
}
