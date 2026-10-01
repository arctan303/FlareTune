import React from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/index.js';

export default function SettingsEditDialog({ title, onClose, children, message, busy }) {
  const dialogRef = React.useRef(null);
  React.useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    dialog.querySelector('input, textarea, select')?.focus();
    return () => { if (dialog.open) dialog.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  return createPortal(
    <dialog ref={dialogRef} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
      className="fixed inset-0 m-auto w-[min(92vw,48rem)] max-h-[85dvh] rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-0 text-[var(--ink)] shadow-2xl backdrop:bg-black/45 backdrop:backdrop-blur-sm">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--line)] bg-[var(--surface-raised)] px-5 py-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <button type="button" onClick={onClose} disabled={busy} className="min-h-11 rounded-lg px-2 py-1 text-sm text-[var(--muted)] hover:bg-[var(--surface)] disabled:opacity-50" aria-label={t('关闭编辑')}>{t('关闭')}</button>
      </div>
      <div className="max-h-[calc(85dvh-5rem)] overflow-y-auto p-5 sm:p-6">
        {message && <div role="alert" className="mb-4 rounded-xl bg-rose-500/10 p-3 text-sm text-rose-600">{t(message)}</div>}
        {children}
      </div>
    </dialog>, document.body,
  );
}
