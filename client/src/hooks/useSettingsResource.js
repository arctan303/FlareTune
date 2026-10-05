import { useCallback, useEffect, useRef, useState } from 'react';

// Refreshes retain the last successful value; only a new resource resets it.
export function useSettingsResource(load) {
  const [state, setState] = useState(() => ({ source: load, data: null, loading: true, error: null }));
  const request = useRef(0);
  const activeLoad = useRef(load);
  activeLoad.current = load;
  const refresh = useCallback(async () => {
    const id = ++request.current;
    const current = () => id === request.current && activeLoad.current === load;
    setState(previous => ({ source: load, data: previous.source === load ? previous.data : null, loading: true, error: null }));
    try {
      const next = await load();
      if (current()) setState({ source: load, data: next, loading: false, error: null });
      return next;
    } catch (cause) {
      if (current()) setState(previous => ({ ...previous, loading: false, error: cause }));
      throw cause;
    }
  }, [load]);
  const setData = useCallback(value => {
    if (activeLoad.current !== load) return;
    // A confirmed write supersedes reads that started before that write.
    request.current += 1;
    setState(previous => ({ source: load, data: typeof value === 'function' ? value(previous.source === load ? previous.data : null) : value,
      loading: false, error: null }));
  }, [load]);
  useEffect(() => {
    activeLoad.current = load;
    void refresh().catch(() => {});
    return () => { request.current += 1; if (activeLoad.current === load) activeLoad.current = null; };
  }, [refresh]);
  return { data: state.source === load ? state.data : null, setData,
    loading: state.source === load ? state.loading : true, error: state.source === load ? state.error : null, refresh };
}
