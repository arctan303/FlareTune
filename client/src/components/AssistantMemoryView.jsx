import React from 'react';
import { instanceRequest } from '../instance/api.js';
import { useUIStore, showToast } from '../store/useUIStore.js';

const sourceLabel = { stated: '对话中提到', inferred: '根据收听推测', user_edited: '由你修改' };

export default function AssistantMemoryView() {
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
      .catch(() => { if (active) setError('记忆暂时无法载入，请重试。'); });
    return () => { active = false; };
  }, [accountId]);

  const retryLoad = async () => {
    setError('');
    try {
      const result = await instanceRequest('ai/memory');
      if (useUIStore.getState().authSession.user?.accountId === accountId) setData(result);
    } catch {
      if (useUIStore.getState().authSession.user?.accountId === accountId) {
        setError('记忆暂时无法载入，请重试。');
      }
    }
  };

  const run = async (operation, success) => {
    setBusy(true); setError('');
    try {
      await operation();
    } catch {
      if (useUIStore.getState().authSession.user?.accountId === accountId) {
        setError('操作未完成，请重试。');
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
        setError('操作已完成，但记忆列表未刷新。请重新载入。');
      }
    }
    finally { setBusy(false); }
  };

  return <div className="h-full overflow-y-auto px-5 py-8 sm:px-10">
    <div className="mx-auto max-w-2xl space-y-7">
      <div>
        <h1 className="text-3xl font-black tracking-tight text-[var(--ink)]">记忆</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">开启后，助手可在对话中逐步记住与你有关的信息，也可能根据收听记录形成推测。每次变更都会提示你。</p>
      </div>
      {error && <div role="alert" className="flex items-center gap-3 text-sm text-red-600 dark:text-red-400">
        <span>{error}</span>{!data && <button type="button" className="underline" onClick={retryLoad}>重新载入</button>}
      </div>}
      {!data ? !error && <p role="status" className="text-sm text-[var(--muted)]">正在载入记忆…</p> : <>
        <label className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <span><strong className="block text-[var(--ink)]">允许助手使用记忆</strong>
            <span className="mt-1 block text-sm text-[var(--muted)]">默认关闭。关闭时助手不能读取或改写，已有内容仍由你管理。</span></span>
          <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--accent)]" checked={data.enabled}
            disabled={busy} onChange={(event) => run(() => instanceRequest('ai/memory', {
              method: 'PATCH', body: { enabled: event.target.checked }, csrfToken: session.csrfToken,
              expectedAccountId: accountId,
            }), event.target.checked ? '记忆已开启' : '记忆已关闭')} />
        </label>
        <section aria-label="已有记忆" className="space-y-3">
          <div className="flex items-baseline justify-between gap-3"><h2 className="text-lg font-semibold text-[var(--ink)]">已有记忆</h2>
            <span className="text-xs text-[var(--muted)]">{data.memories.length} / 30</span></div>
          {data.memories.length === 0 && <p className="rounded-2xl border border-[var(--line)] p-5 text-sm text-[var(--muted)]">还没有记忆。开启后，助手会在对话中逐步形成。</p>}
          {data.memories.map((item) => <div key={item.id} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
            {editingId === item.id ? <form onSubmit={(event) => {
              event.preventDefault();
              void run(() => instanceRequest(`ai/memory/${item.id}`, { method: 'PUT',
                body: { content: draft }, csrfToken: session.csrfToken,
                expectedAccountId: accountId }), '记忆已修改');
            }} className="space-y-3">
              <label className="block text-sm font-medium text-[var(--ink)]">修改记忆
                <textarea className="mt-2 min-h-24 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] p-3 text-[var(--ink)]"
                  maxLength={240} value={draft} onChange={(event) => setDraft(event.target.value)} required />
              </label>
              <div className="flex gap-3"><button className="primary-button rounded-xl px-4 py-2 text-sm" disabled={busy}>保存</button>
                <button type="button" className="text-sm text-[var(--muted)]" disabled={busy} onClick={() => setEditingId(null)}>取消</button></div>
            </form> : <>
              <p className="whitespace-pre-wrap break-words text-sm text-[var(--ink)]">{item.content}</p>
              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                <span>{sourceLabel[item.source] || '记忆'}</span><span className="flex gap-4">
                  <button type="button" disabled={busy} onClick={() => { setEditingId(item.id); setDraft(item.content); }}>修改</button>
                  <button type="button" disabled={busy} className="text-red-600 dark:text-red-400" onClick={() => {
                    if (window.confirm('确定删除这条记忆吗？')) void run(() => instanceRequest(`ai/memory/${item.id}`, {
                      method: 'DELETE', body: {}, csrfToken: session.csrfToken,
                      expectedAccountId: accountId,
                    }), '记忆已删除');
                  }}>删除</button></span>
              </div>
            </>}
          </div>)}
        </section>
      </>}
    </div>
  </div>;
}
