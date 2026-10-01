import React from 'react';
import { useUIStore } from '../store/useUIStore.js';
import { uploadUserImage, saveUserImageSlot, imageErrorMessage, discardUserImage } from '../services/userImages.js';
import ImageCropDialog from './ImageCropDialog.jsx';
import { t } from '../i18n/index.js';
export default function UserImageEditor({ purpose, targetId, slot, onSaved }) {
  const session = useUIStore(state => state.authSession); const owner = session.user?.accountId;
  const [file, setFile] = React.useState(null); const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState('');
  const mounted = React.useRef(false);
  React.useEffect(() => { mounted.current = true; setFile(null); setError(''); return () => { mounted.current = false; }; }, [owner, targetId]);
  const save = async blob => {
    let uploaded;
    try {
      uploaded = blob ? await uploadUserImage(blob, purpose, session) : null;
      if (!mounted.current) { if (uploaded) void discardUserImage(uploaded.id, session); return; }
      const next = await saveUserImageSlot(purpose, targetId, uploaded?.id ?? null, slot?.revision ?? 0, session);
      if (mounted.current) onSaved(next);
    } catch (cause) { if (uploaded) void discardUserImage(uploaded.id, session); throw new Error(imageErrorMessage(cause)); }
  };
  const remove = async () => {
    setBusy(true); setError(''); try { await save(null); } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  return <div className="mt-3 space-y-2">
    <div className="flex flex-wrap items-center gap-3"><label className="inline-flex min-h-11 cursor-pointer items-center rounded-xl border border-[var(--line)] px-4 text-sm focus-within:ring-2 focus-within:ring-[var(--accent)]">{t(purpose === 'avatar' ? '上传头像' : '上传封面')}
      <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e => { setFile(e.target.files?.[0] || null); e.target.value = ''; }} /></label>
      {slot?.url && <button type="button" className="min-h-11 px-3 text-sm text-[var(--muted)]" disabled={busy} onClick={remove}>{t('移除图片')}</button>}</div>
    {error && <p role="alert" className="text-sm text-red-500">{t(error)}</p>}
    {file && <ImageCropDialog key={`${owner}:${targetId}`} file={file} purpose={purpose} onSave={save} onClose={() => setFile(null)} />}
  </div>;
}
