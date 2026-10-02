import React from 'react';
import { t } from '../i18n/index.js';
import { decodeUserImage, cropRectangle, encodeUserImage } from '../services/imageProcessing.js';
export default function ImageCropDialog({ file, purpose, onSave, onClose }) {
  const dialog = React.useRef(null); const canvas = React.useRef(null); const drag = React.useRef(null);
  const [image, setImage] = React.useState(null); const [zoom, setZoom] = React.useState(1);
  const [position, setPosition] = React.useState({ x: 0.5, y: 0.5 }); const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    const element = dialog.current; element.showModal(); let active = true; let decoded;
    void decodeUserImage(file).then(value => {
      decoded = value; if (active) setImage(value); else value.close();
    }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; decoded?.close(); if (element.open) element.close(); };
  }, [file]);
  React.useEffect(() => {
    if (!image || !canvas.current) return;
    const crop = cropRectangle(image.width, image.height, zoom, position.x, position.y);
    const context = canvas.current.getContext('2d'); context.clearRect(0, 0, 300, 300);
    context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, 300, 300);
  }, [image, zoom, position]);
  const save = async () => {
    setBusy(true); setError('');
    try { await onSave(await encodeUserImage(image, { purpose, zoom, ...position })); onClose(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} aria-labelledby="image-crop-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}
    className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-6 text-[var(--ink)] shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm">
    <h2 id="image-crop-title" className="mb-4 text-base font-bold">{t(purpose === 'avatar' ? '裁剪头像' : '裁剪歌单封面')}</h2>
    <canvas ref={canvas} width={300} height={300} aria-label={t('图片裁剪预览')}
      className={`mx-auto aspect-square w-full max-w-[300px] bg-[var(--surface-raised)] ${purpose === 'avatar' ? 'rounded-full' : 'rounded-xl'}`}
      style={{ touchAction: 'none' }} onPointerDown={event => { if (busy) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY }; }}
      onPointerMove={event => { if (!drag.current || !image) return; const r = cropRectangle(image.width, image.height, zoom);
        const scale = r.size / event.currentTarget.clientWidth;
        const start = drag.current;
        setPosition(previous => ({ x: Math.max(0, Math.min(1, previous.x - (event.clientX - start.x) * scale / Math.max(1, image.width - r.size))),
          y: Math.max(0, Math.min(1, previous.y - (event.clientY - start.y) * scale / Math.max(1, image.height - r.size))) }));
        drag.current = { x: event.clientX, y: event.clientY };
      }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
    <div className="mt-4 space-y-3">
      <label className="block text-xs font-semibold">{t('缩放')}<input type="range" aria-label={t('缩放')} min="1" max="4" step="0.01" value={zoom} disabled={busy} onChange={e => setZoom(Number(e.target.value))} className="block w-full accent-[var(--accent)]" /></label>
      {['x','y'].map(axis => <label key={axis} className="block text-xs font-semibold">{t(axis === 'x' ? '水平位置' : '垂直位置')}<input type="range" aria-label={t(axis === 'x' ? '水平位置' : '垂直位置')} min="0" max="1" step="0.01" value={position[axis]} disabled={busy} onChange={e => setPosition(p => ({ ...p, [axis]: Number(e.target.value) }))} className="block w-full accent-[var(--accent)]" /></label>)}
    </div>
    {error && <p role="alert" className="mt-3 text-xs text-red-500">{t(error)}</p>}
    <div className="mt-5 flex justify-end items-center gap-2.5 pt-3 border-t border-[var(--line)]">
      <button type="button" disabled={busy} onClick={onClose} className="rounded-xl px-4 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer">{t('取消')}</button>
      <button type="button" disabled={busy || !image} onClick={save} className="primary-button rounded-xl px-5 py-2 text-xs font-semibold disabled:opacity-50 cursor-pointer shadow-xs">{t(busy ? '正在保存…' : '保存图片')}</button>
    </div>
  </dialog>;
}
