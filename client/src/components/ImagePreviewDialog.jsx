import React from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n/index.js';
import PrivateCoverImage from './PrivateCoverImage.jsx';

export default function ImagePreviewDialog({ image, onClose }) {
  const dialog = React.useRef(null);
  React.useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element.showModal();
    return () => {
      if (element.open) element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return <dialog ref={dialog} aria-label={t('图片预览')}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-4xl rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)] backdrop:bg-black/60">
    <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">{t('图片预览')}</h2><button type="button" autoFocus aria-label={t('关闭图片预览')} onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-full"><X size={20} /></button></div>
    <PrivateCoverImage src={image.url} alt={t('聊天图片')} className="mx-auto max-h-[calc(100dvh-9rem)] max-w-full rounded-lg object-contain" />
  </dialog>;
}
