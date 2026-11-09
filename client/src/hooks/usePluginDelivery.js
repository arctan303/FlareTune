import { useCallback, useEffect, useRef, useState } from 'react';
import { pluginDeliveryRequest, deliveryErrorMessage } from '../services/pluginDelivery.js';
import { isDemoRuntime } from '../services/runtimeFetch.js';
import { ACTIVE_PLUGIN_BUILDS } from '../../../shared/plugins/delivery.js';

export const activePluginBuild = build => ACTIVE_PLUGIN_BUILDS.has(build?.status) && !build?.resultUnknown;
const subject = session => !isDemoRuntime && session?.authenticated && session.user?.role === 'admin'
  ? JSON.stringify([session.user.accountId, session.csrfToken]) : '';

export function usePluginDelivery(session) {
  const owner = subject(session);
  const current = useRef(owner); current.current = owner;
  const controller = useRef(null), inFlight = useRef(false), sequence = useRef(0);
  const [state, setState] = useState({ owner: '', data: null, loading: false, busy: false, error: '' });
  const refresh = useCallback(async () => {
    if (!owner) return null;
    const serial = ++sequence.current;
    setState(previous => ({ ...previous, owner, loading: true }));
    try {
      const data = await pluginDeliveryRequest(session, '', { signal: controller.current?.signal });
      if (current.current !== owner || serial !== sequence.current) return null;
      setState(previous => ({ ...previous, owner, data, loading: false, error: '' }));
      return data;
    } catch (error) {
      if (current.current === owner && serial === sequence.current && !controller.current?.signal.aborted) {
        setState(previous => ({ ...previous, owner, loading: false, error: deliveryErrorMessage(error) }));
      }
      return null;
    }
  }, [owner]);
  useEffect(() => {
    controller.current = new AbortController(); inFlight.current = false;
    setState({ owner, data: null, loading: !!owner, busy: false, error: '' });
    void refresh();
    return () => { controller.current?.abort(); ++sequence.current; };
  }, [owner, refresh]);
  const action = useCallback(async (path, method = 'POST', body = {}) => {
    if (!owner || current.current !== owner || inFlight.current || !state.data) return null;
    inFlight.current = true; ++sequence.current;
    const signal = controller.current?.signal;
    setState(previous => ({ ...previous, busy: true, error: '' }));
    try {
      const data = await pluginDeliveryRequest(session, path, { method, body: { revision: state.data.revision, ...body }, signal });
      if (current.current !== owner || signal?.aborted) return null;
      setState({ owner, data, busy: false, loading: false, error: '' });
      return data;
    } catch (error) {
      if (current.current === owner && !signal?.aborted) {
        await refresh();
        if (current.current === owner) setState(previous => ({ ...previous, busy: false, error: deliveryErrorMessage(error) }));
      }
      throw error;
    } finally { if (current.current === owner) inFlight.current = false; }
  }, [owner, state.data, refresh]);
  const data = state.owner === owner && owner ? state.data : null;
  useEffect(() => {
    if (!owner || !activePluginBuild(data?.build)) return;
    const timer = setInterval(() => { if (!inFlight.current) void refresh(); }, 4000);
    return () => clearInterval(timer);
  }, [owner, data?.build?.status, refresh]);
  return { data, loading: state.owner !== owner ? !!owner : state.loading, busy: state.owner === owner && state.busy,
    error: state.owner === owner ? state.error : '', demo: isDemoRuntime, refresh, action };
}
