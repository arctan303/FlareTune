import React from 'react';
import { Camera, Trash2 } from 'lucide-react';
import { useUIStore } from '../store/useUIStore.js';
import { uploadUserImage, saveUserImageSlot, imageErrorMessage, discardUserImage } from '../services/userImages.js';
import ImageCropDialog from './ImageCropDialog.jsx';
import { t } from '../i18n/index.js';

export default function UserImageEditor({
  purpose,
  targetId,
  slot,
  onSaved,
  variant = 'default',
  compact = false,
  className = '',
}) {
  const session = useUIStore((state) => state.authSession);
  const owner = session.user?.accountId;
  const [file, setFile] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const mounted = React.useRef(false);

  React.useEffect(() => {
    mounted.current = true;
    setFile(null);
    setError('');
    return () => {
      mounted.current = false;
    };
  }, [owner, targetId]);

  const save = async (blob) => {
    let uploaded;
    try {
      uploaded = blob ? await uploadUserImage(blob, purpose, session) : null;
      if (!mounted.current) {
        if (uploaded) void discardUserImage(uploaded.id, session);
        return;
      }
      const next = await saveUserImageSlot(
        purpose,
        targetId,
        uploaded?.id ?? null,
        slot?.revision ?? 0,
        session
      );
      if (mounted.current) onSaved(next);
    } catch (cause) {
      if (uploaded) void discardUserImage(uploaded.id, session);
      throw new Error(imageErrorMessage(cause));
    }
  };

  const remove = async (event) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    setBusy(true);
    setError('');
    try {
      await save(null);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  if (variant === 'overlay') {
    return (
      <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center rounded-xl bg-black/60 p-3 backdrop-blur-[2px] text-white transition-all ${className}`}>
        <label className="group flex h-full w-full cursor-pointer flex-col items-center justify-center gap-1.5 text-center select-none">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 shadow-xs transition-all duration-200 group-hover:scale-110 group-hover:bg-white/30">
            <Camera size={20} className="text-white drop-shadow-xs" aria-hidden="true" />
          </div>
          <span className="text-xs font-semibold tracking-wide text-white drop-shadow-xs">
            {t(slot?.url ? '更换封面' : '上传封面')}
          </span>
          <input
            className="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              e.target.value = '';
            }}
          />
        </label>
        {slot?.url && (
          <button
            type="button"
            className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-black/40 px-2 py-0.5 text-[11px] font-medium text-red-300 transition-colors hover:bg-black/60 hover:text-red-200 cursor-pointer"
            disabled={busy}
            onClick={remove}
          >
            <Trash2 size={11} aria-hidden="true" />
            <span>{t('移除封面')}</span>
          </button>
        )}
        {error && <p role="alert" className="mt-1 text-center text-xs font-medium text-red-400">{t(error)}</p>}
        {file && (
          <ImageCropDialog
            key={`${owner}:${targetId}`}
            file={file}
            purpose={purpose}
            onSave={save}
            onClose={() => setFile(null)}
          />
        )}
      </div>
    );
  }

  const isCompact = compact || variant === 'compact';

  return (
    <div className={`${isCompact ? 'mt-2 space-y-1' : 'mt-3 space-y-2'} ${className}`}>
      <div className={`flex flex-wrap items-center gap-2 ${isCompact ? 'justify-center' : ''}`}>
        <label className={`inline-flex cursor-pointer items-center rounded-xl border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--surface-raised)] hover:border-[var(--line-strong)] transition-colors focus-within:ring-2 focus-within:ring-[var(--accent)] ${isCompact ? 'px-2.5 py-1 text-xs font-medium' : 'min-h-11 px-4 text-sm'}`}>
          {t(purpose === 'avatar' ? (slot?.url ? '更换头像' : '上传头像') : (slot?.url ? '更换封面' : '上传封面'))}
          <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e => { setFile(e.target.files?.[0] || null); e.target.value = ''; }} />
        </label>
        {slot?.url && (
          <button type="button" className={`rounded-lg text-[var(--muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors ${isCompact ? 'px-2 py-1 text-xs' : 'min-h-11 px-3 text-sm'}`} disabled={busy} onClick={remove}>
            {t('移除图片')}
          </button>
        )}
      </div>
      {error && <p role="alert" className={`text-xs text-red-500 ${isCompact ? 'text-center' : ''}`}>{t(error)}</p>}
      {file && <ImageCropDialog key={`${owner}:${targetId}`} file={file} purpose={purpose} onSave={save} onClose={() => setFile(null)} />}
    </div>
  );
}
