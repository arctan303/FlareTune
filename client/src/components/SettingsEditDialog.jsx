import React from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/index.js';
import { SettingsButton, SettingsDialogContext } from './SettingsControls.jsx';

export default function SettingsEditDialog({ title, onClose, children, message, busy, size = 'large', closeOnBackdrop = false, messageTone = 'error' }) {
  const dialogRef = React.useRef(null);
  const closeTimer = React.useRef(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = React.useRef(busy);
  busyRef.current = busy;
  const [closing, setClosing] = React.useState(false);
  const requestClose = () => {
    if (busy || closeTimer.current !== null) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { onCloseRef.current(); return; }
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (busyRef.current) setClosing(false);
      else onCloseRef.current();
    }, 150);
  };
  React.useEffect(() => {
    if (!busy || closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setClosing(false);
  }, [busy]);
  React.useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    dialog.querySelector('[autofocus], input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')?.focus();
    return () => {
      clearTimeout(closeTimer.current);
      if (dialog.open) dialog.close();
      if (opener?.isConnected && !document.querySelector('dialog[open]')) opener.focus();
    };
  }, []);
  return createPortal(
    <SettingsDialogContext.Provider value={requestClose}><dialog ref={dialogRef} aria-label={title} onCancel={event => { event.preventDefault(); requestClose(); }}
      onClick={event => { if (closeOnBackdrop && event.target === event.currentTarget) requestClose(); }}
      data-closing={closing || undefined} data-size={size} inert={closing ? '' : undefined}
      onSubmitCapture={event => {
        if (closing || closeTimer.current !== null) { event.preventDefault(); event.stopPropagation(); }
      }}
      className="settings-edit-dialog fixed inset-0 m-auto max-h-[85dvh] rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-0 text-[var(--ink)] shadow-2xl backdrop:bg-black/45 backdrop:backdrop-blur-sm">
      <div className="shrink-0 sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--surface-raised)] px-5 py-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <SettingsButton onClick={requestClose} disabled={busy || closing} variant="quiet" aria-label={t('关闭编辑')}>{t('关闭')}</SettingsButton>
      </div>
      <div className="settings-edit-dialog__body overflow-y-auto p-5 sm:p-6">
        {message && <div role={messageTone === 'error' ? 'alert' : 'status'} className={`mb-4 rounded-xl p-3 text-sm ${messageTone === 'error' ? 'bg-rose-500/10 text-rose-600' : 'bg-[var(--surface)] text-[var(--muted)]'}`}>{t(message)}</div>}
        {children}
      </div>
    </dialog></SettingsDialogContext.Provider>, document.body,
  );
}
