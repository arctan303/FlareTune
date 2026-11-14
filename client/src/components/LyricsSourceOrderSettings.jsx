import React from 'react';
import { ArrowUp, ArrowDown, RefreshCw } from 'lucide-react';
import { t, useLocale } from '../i18n/index.js';
import { getLyricSourceOrder, putLyricSourceOrder } from '../services/lyricsApi.js';
import Section from './SettingsSection.jsx';
import { SettingsActions, SettingsButton } from './SettingsControls.jsx';
import { moveLyricSource, orderedLyricSources } from './lyricSourceOrder.js';

export default function LyricsSourceOrderSettings({ session }) {
  const locale = useLocale();
  const [snapshot, setSnapshot] = React.useState(null);
  const [order, setOrder] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const sequence = React.useRef(0);
  const apply = React.useCallback(value => {
    const data = value?.data || value;
    const sources = orderedLyricSources(data);
    const next = sources.map(source => source.id);
    setSnapshot({ ...data, sources, order: next });
    setOrder(next);
  }, []);
  const load = React.useCallback(async signal => {
    const current = ++sequence.current;
    setBusy(true); setError('');
    try {
      const result = await getLyricSourceOrder({ session, signal });
      if (current === sequence.current && !signal?.aborted) apply(result);
    } catch (failure) {
      if (current === sequence.current && !signal?.aborted) setError(failure.message);
    } finally {
      if (current === sequence.current && !signal?.aborted) setBusy(false);
    }
  }, [session, apply]);
  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => { ++sequence.current; controller.abort(); };
  }, [load]);
  const save = async () => {
    const current = ++sequence.current;
    setBusy(true); setError('');
    try {
      const result = await putLyricSourceOrder(order, snapshot.revision, { session });
      if (current === sequence.current) apply(result);
    } catch (failure) {
      if (current === sequence.current) setError(failure.message);
    } finally { if (current === sequence.current) setBusy(false); }
  };
  const changed = snapshot && JSON.stringify(order) !== JSON.stringify(snapshot.order);
  const byId = new Map(snapshot?.sources.map(source => [source.id, source]));
  return <Section title={t('歌词来源顺序')} action={<SettingsActions>
    <SettingsButton onClick={() => void load()} disabled={busy} aria-label={t('刷新数据')} title={t('刷新数据')}>
      <RefreshCw size={14} aria-hidden="true" />
    </SettingsButton>
    <SettingsButton variant="primary" disabled={busy || !changed} onClick={() => void save()}>{t('保存')}</SettingsButton>
  </SettingsActions>}>
    {error && <p role="alert" className="mb-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
    {busy && !snapshot ? <p role="status" className="text-xs text-[var(--muted)]">{t('正在加载…')}</p> : <ol className="divide-y divide-[var(--line)]">
      {order.map((id, index) => {
        const source = byId.get(id), name = source?.metadata?.[locale]?.name
          || (typeof source?.name === 'string' ? t(source.name) : id);
        return <li key={id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <span className="min-w-0 break-words text-xs font-medium text-[var(--ink)]">{name}</span>
          <SettingsActions className="shrink-0">
            <SettingsButton disabled={busy || index === 0} onClick={() => setOrder(current => moveLyricSource(current, id, -1))}
              aria-label={t('上移“{name}”', { name })} title={t('上移“{name}”', { name })}><ArrowUp size={14} aria-hidden="true" /></SettingsButton>
            <SettingsButton disabled={busy || index === order.length - 1} onClick={() => setOrder(current => moveLyricSource(current, id, 1))}
              aria-label={t('下移“{name}”', { name })} title={t('下移“{name}”', { name })}><ArrowDown size={14} aria-hidden="true" /></SettingsButton>
          </SettingsActions>
        </li>;
      })}
    </ol>}
  </Section>;
}
