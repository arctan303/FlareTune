import React from 'react';
import { t } from '../../i18n/index.js';
import { isTopmostModal, trapDrawerTabKey } from './drawerFocus.js';

// The lazy drawer's boundary owns final focus restoration. This temporary
// surface only owns focus while waiting or recovering, so replacing it with the
// real drawer cannot send focus back into the inert application underneath.
export default function DrawerFallbackSurface({ title, isOpen = true, isFullScreen = false, panelClassName = 'sm:w-[380px]', onClose, error = false, onReload }) {
  const rootRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const closeRef = React.useRef(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => {
    if (!isOpen) return undefined;
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = event => {
      if (event.defaultPrevented || !isTopmostModal(rootRef.current, document)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current?.();
      } else trapDrawerTabKey(event, panelRef.current, document.activeElement);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen]);
  if (!isOpen) return null;
  return <div ref={rootRef} role="dialog" aria-modal="true" aria-label={title} className={`fixed inset-0 z-[120] flex justify-end${isFullScreen ? ' dark' : ''}`}>
    <div className="absolute inset-0 drawer-backdrop" onClick={() => onCloseRef.current?.()} />
    <section ref={panelRef} tabIndex={-1} className={`theme-drawer relative flex h-full w-full max-w-full flex-col overflow-y-auto p-6 ${panelClassName}`}>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h2 className="min-w-0 break-words text-base font-semibold">{title}</h2>
        <button ref={closeRef} type="button" onClick={onClose} className="settings-button settings-button--quiet">{t('关闭')}</button>
      </div>
      {error ? <div>
        <p role="alert" className="mb-5 text-sm text-[var(--muted)]">{t('组件暂时不可用')}</p>
        <button type="button" onClick={onReload} className="settings-button settings-button--primary primary-button">{t('刷新页面')}</button>
      </div> : <div role="status" aria-label={t('正在加载…')}>
        <p className="mb-5 text-sm text-[var(--muted)]">{t('正在加载…')}</p>
        <div aria-hidden="true" className="space-y-4">
          {Array.from({ length: 5 }, (_, index) => <div key={index} className="flex items-center gap-3">
            <div className="catalog-skeleton__block h-12 w-12 shrink-0 rounded-lg" />
            <div className="flex-1 space-y-2"><div className="catalog-skeleton__block h-3 w-3/4" /><div className="catalog-skeleton__block h-2 w-1/2" /></div>
          </div>)}
        </div>
      </div>}
    </section>
  </div>;
}
