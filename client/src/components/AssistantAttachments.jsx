import React from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n/index.js';
import { decodeUserImage, encodeUserImage } from '../services/imageProcessing.js';
import { uploadUserImage, discardUserImage } from '../services/userImages.js';
import PrivateCoverImage from './PrivateCoverImage.jsx';
import ImagePreviewDialog from './ImagePreviewDialog.jsx';
import { useUIStore } from '../store/useUIStore.js';
export default React.forwardRef(function AssistantAttachments({ attachments, onChange, disabled, onBusy, session }, ref) {
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState(''); const active = React.useRef(true);
  const busyRef = React.useRef(false); const input = React.useRef(null);
  const [previewId, setPreviewId] = React.useState(null);
  const preview = attachments.find(image => image.id === previewId);
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const add = async files => {
    if (!files.length || busyRef.current || disabled || !active.current) return;
    if (files.length + attachments.length > 4) { setError('单次最多附加 4 张图片。'); return; }
    busyRef.current = true;
    setBusy(true); onBusy(true); setError(''); const uploaded = [];
    try {
      for (const file of files) {
        const image = await decodeUserImage(file);
        try { uploaded.push(await uploadUserImage(await encodeUserImage(image, { purpose: 'chat' }), 'chat', session)); }
        finally { image.close(); }
      }
      if (active.current && useUIStore.getState().authSession.user?.accountId === session.user.accountId) onChange([...attachments, ...uploaded]);
      else uploaded.forEach(image => void discardUserImage(image.id, session));
    } catch (cause) { uploaded.forEach(image => void discardUserImage(image.id, session)); if (active.current) setError(cause.message); }
    finally { busyRef.current = false; if (active.current) { setBusy(false); onBusy(false); } }
  };
  React.useImperativeHandle(ref, () => ({
    pick: () => input.current?.click(),
    addFiles: files => { void add(files); },
  }));
  return <div className={attachments.length || busy || error ? 'space-y-2 px-3 pt-3' : ''}>
    <input ref={input} hidden aria-label={t('选择图片文件')} type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy || disabled || attachments.length >= 4} onChange={event => { void add(Array.from(event.target.files || [])); event.target.value = ''; }} />
    {attachments.length > 0 && <div className="flex flex-wrap gap-2">{attachments.map((image, index) => <div key={image.id} className="relative">
      <button type="button" aria-label={t('查看第 {position} 张图片', { position: index + 1 })} className="block rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => setPreviewId(image.id)}>
        <PrivateCoverImage src={image.url} alt={t('待发送图片')} className="h-16 w-16 rounded-lg object-contain" />
      </button>
      <button type="button" disabled={disabled || busy} className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--surface)] shadow-sm" aria-label={t('移除第 {position} 张图片', { position: index + 1 })} onClick={() => { if (previewId === image.id) setPreviewId(null); onChange(attachments.filter(item => item.id !== image.id)); void discardUserImage(image.id, session); }}><X size={13} aria-hidden="true" /></button></div>)}</div>}
    {busy && <p role="status" className="text-xs text-[var(--muted)]">{t('正在处理图片…')}</p>}
    {error && <p role="alert" className="text-xs text-red-500">{t(error)}</p>}
    {preview && <ImagePreviewDialog key={preview.url} image={preview} onClose={() => setPreviewId(null)} />}
  </div>;
});
