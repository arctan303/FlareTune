import { t, useLocale } from '../i18n/index.js';
import React from 'react';
import { instanceRequest } from '../instance/api.js';
import { useUIStore, showToast } from '../store/useUIStore.js';

const sourceLabel = { stated: '对话中提到', inferred: '根据收听推测', user_edited: '由你修改' };

function MemoryTime({ value, label, formatter }) {
  const date = typeof value === 'number' && Number.isFinite(value) ? new Date(value) : null;
  return <span className="whitespace-nowrap">{label} {date && !Number.isNaN(date.getTime())
    ? <time dateTime={date.toISOString()}>{formatter.format(date)}</time> : '—'}</span>;
}

export default function AssistantMemoryView() {
  const locale = useLocale();
  const dateFormatter = React.useMemo(() => new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }), [locale]);
  const session = useUIStore((state) => state.authSession);
  const accountId = session.user?.accountId;
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [editingId, setEditingId] = React.useState(null);
  const [draft, setDraft] = React.useState('');

  React.useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    instanceRequest('ai/memory').then((result) => { if (active) setData(result); })
      .catch(() => { if (active) setError(t("记忆暂时无法载入，请重试。")); });
    return () => { active = false; };
  }, [accountId]);

  const retryLoad = async () => {
    setError('');
    try {
      const result = await instanceRequest('ai/memory');
      if (useUIStore.getState().authSession.user?.accountId === accountId) setData(result);
    } catch {
      if (useUIStore.getState().authSession.user?.accountId === accountId) {
        setError(t("记忆暂时无法载入，请重试。"));
      }
    }
  };

  const run = async (operation, success) => {
    setBusy(true); setError('');
    try {
      await operation();
    } catch {
      if (useUIStore.getState().authSession.user?.accountId === accountId) {
        setError(t("操作未完成，请重试。"));
      }
      setBusy(false);
      return;
    }
    if (useUIStore.getState().authSession.user?.accountId === accountId) showToast(success);
    try {
      const next = await instanceRequest('ai/memory');
      if (useUIStore.getState().authSession.user?.accountId === accountId) {
        setData(next); setEditingId(null); setDraft('');
      }
    } catch {
      if (useUIStore.getState().authSession.user?.accountId === accountId) {
        setData(null);
        setError(t("操作已完成，但记忆列表未刷新。请重新载入。"));
      }
    }
    finally { setBusy(false); }
  };

  return <div className="h-full overflow-y-auto px-5 py-8 sm:px-10">
    <div className="mx-auto max-w-2xl space-y-7">
      <div>
        <h1 className="text-3xl font-black tracking-tight text-[var(--ink)]">{t("记忆")}</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">{t("开启后，助手可在对话中逐步记住与你有关的信息，也可能根据收听记录形成推测。每次变更都会提示你。")}</p>
      </div>
      {error && <div role="alert" className="flex items-center gap-3 text-sm text-red-600 dark:text-red-400">
        <span>{t(error)}</span>{!data && <button type="button" className="underline" onClick={retryLoad}>{t("重新载入")}</button>}
      </div>}
      {!data ? !error && <p role="status" className="text-sm text-[var(--muted)]">{t("正在载入记忆…")}</p> : <>
        <label className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <span><strong className="block text-[var(--ink)]">{t("允许助手使用记忆")}</strong>
            <span className="mt-1 block text-sm text-[var(--muted)]">{t("默认关闭。关闭时助手不能读取或改写，已有内容仍由你管理。")}</span></span>
          <input type="checkbox" role="switch" className="settings-switch" checked={data.enabled}
            disabled={busy} onChange={(event) => run(() => instanceRequest('ai/memory', {
              method: 'PATCH', body: { enabled: event.target.checked }, csrfToken: session.csrfToken,
              expectedAccountId: accountId,
            }), event.target.checked ? t("记忆已开启") : t("记忆已关闭"))} />
        </label>
        <section aria-label={t("已有记忆")} className="space-y-3">
          <div className="flex items-baseline justify-between gap-3"><h2 className="text-lg font-semibold text-[var(--ink)]">{t("已有记忆")}</h2>
            <span className="text-xs text-[var(--muted)]">{data.memories.length} / 30</span></div>
          {data.memories.length === 0 && <p className="rounded-2xl border border-[var(--line)] p-5 text-sm text-[var(--muted)]">{t("暂无记忆")}</p>}
          {data.memories.map((item) => <div key={item.id} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
            {editingId === item.id ? <form onSubmit={(event) => {
              event.preventDefault();
              void run(() => instanceRequest(`ai/memory/${item.id}`, { method: 'PUT',
                body: { content: draft }, csrfToken: session.csrfToken,
                expectedAccountId: accountId }), t("记忆已修改"));
            }} className="space-y-3">
              <label className="block text-sm font-medium text-[var(--ink)]">{t("修改记忆")}<textarea className="mt-2 min-h-24 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] p-3 text-[var(--ink)]"
                  maxLength={240} value={draft} onChange={(event) => setDraft(event.target.value)} required />
              </label>
              <div className="flex gap-3"><button className="primary-button rounded-xl px-4 py-2 text-sm" disabled={busy}>{t("保存")}</button>
                <button type="button" className="text-sm text-[var(--muted)]" disabled={busy} onClick={() => setEditingId(null)}>{t("取消")}</button></div>
            </form> : <>
              <p className="whitespace-pre-wrap break-words text-sm text-[var(--ink)]">{item.content}</p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs text-[var(--muted)]">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span>{t(sourceLabel[item.source] || '记忆')}</span>
                  <MemoryTime value={item.createdAt} label={t('创建于')} formatter={dateFormatter} />
                  <MemoryTime value={item.updatedAt} label={t('修改于')} formatter={dateFormatter} />
                </div><span className="ml-auto flex shrink-0 gap-4">
                  <button type="button" disabled={busy} onClick={() => { setEditingId(item.id); setDraft(item.content); }}>{t("修改")}</button>
                  <button type="button" disabled={busy} className="text-red-600 dark:text-red-400" onClick={() => {
                    if (window.confirm(t("确定删除这条记忆吗？"))) void run(() => instanceRequest(`ai/memory/${item.id}`, {
                      method: 'DELETE', body: {}, csrfToken: session.csrfToken,
                      expectedAccountId: accountId,
                    }), t("记忆已删除"));
                  }}>{t("删除")}</button></span>
              </div>
            </>}
          </div>)}
        </section>
      </>}
    </div>
  </div>;
}
