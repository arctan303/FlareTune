import SelectControl from './SelectControl.jsx';
import { t } from '../i18n/index.js';
import React from 'react';
import { ALL_LANGUAGES } from '../constants/language.js';
import { resolveCoverUrl } from '../utils.js';
import { getCatalogSong, updateCatalogSong, uploadCatalogMedia } from '../services/catalogAdminApi.js';
import { createQuickSongPatch } from '../utils/quickSongEditPatch.js';
import PrivateCoverImage from './PrivateCoverImage.jsx';

const editableFields = ['title', 'artist', 'album', 'language'];

export default function QuickSongEditDialog({ songId, onClose, onSaved }) {
  const dialogRef = React.useRef(null);
  const titleRef = React.useRef(null);
  const uploadedCoverRef = React.useRef(null);
  const [song, setSong] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [file, setFile] = React.useState(null);
  const [previewUrl, setPreviewUrl] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const detail = (await getCatalogSong(songId)).song;
      setSong(detail);
      setDraft(Object.fromEntries(editableFields.map((key) => [key, detail[key] || ''])));
      setFile(null);
      uploadedCoverRef.current = null;
      requestAnimationFrame(() => titleRef.current?.focus());
    } catch (cause) {
      setError(cause?.message || '歌曲信息加载失败。');
    } finally {
      setLoading(false);
    }
  }, [songId]);

  React.useEffect(() => { void reload(); }, [reload]);
  React.useEffect(() => {
    if (!file) { setPreviewUrl(null); return undefined; }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const save = async (event) => {
    event.preventDefault();
    if (!song || !draft || saving) return;
    const patch = createQuickSongPatch(song, draft);
    if (Object.keys(patch).length === 0 && !file) { onClose(); return; }
    setSaving(true);
    setError('');
    let stage = 'upload';
    try {
      if (file) {
        uploadedCoverRef.current ||= (await uploadCatalogMedia('cover', file)).url;
        patch.cover_url = uploadedCoverRef.current;
      }
      stage = 'save';
      const updated = (await updateCatalogSong(songId, { ...patch, expectedVersion: song.version })).song;
      onSaved(updated);
      onClose();
    } catch (cause) {
      setError(stage === 'save' && cause?.status === 409 ? '歌曲已被其他操作修改。请重新读取后再编辑。' : cause?.message || '保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialogRef} onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }} aria-labelledby="quick-song-edit-title" className="w-[min(92vw,36rem)] max-h-[85vh] rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-0 text-[var(--ink)] shadow-2xl backdrop:bg-black/45 backdrop:backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4"><h2 id="quick-song-edit-title" className="text-lg font-semibold">{t("编辑歌曲信息")}</h2><button type="button" onClick={onClose} disabled={saving} className="text-sm text-[var(--muted)] disabled:opacity-50">{t("关闭")}</button></div>
      <form onSubmit={save} className="max-h-[calc(85vh-4rem)] space-y-5 overflow-y-auto p-5 sm:p-6">
        {loading ? <p role="status" className="py-8 text-center text-sm text-[var(--muted)]">{t("正在读取歌曲…")}</p> : song && draft ? <>
          <div className="flex items-center gap-4 rounded-xl bg-[var(--surface)] p-3">
            {previewUrl || song.cover_url ? <PrivateCoverImage src={previewUrl || resolveCoverUrl(song.cover_url)} alt={t("当前歌曲封面预览")} className="h-20 w-20 shrink-0 rounded-lg object-cover" /> : <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-[var(--line)] text-xs text-[var(--muted)]">{t("无封面")}</span>}
            <div className="min-w-0"><strong className="block truncate text-sm">{song.title}</strong><span className="block truncate text-xs text-[var(--muted)]">{song.artist || t("未知歌手")}</span><label className="mt-2 inline-flex cursor-pointer items-center rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs hover:border-[var(--accent)]">{t("替换封面")}<input type="file" accept=".jpg,.jpeg,.png,.webp" className="sr-only" onChange={(event) => { setFile(event.target.files?.[0] || null); uploadedCoverRef.current = null; }} /></label>{file && <span className="ml-2 text-xs text-[var(--muted)]">{file.name}</span>}</div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="sm:col-span-2 text-xs font-semibold">{t("歌曲标题")}<input ref={titleRef} required maxLength={300} value={draft.title} onChange={(event) => setDraft((old) => ({ ...old, title: event.target.value }))} className="mt-1.5 block w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm" /></label>
            <label className="text-xs font-semibold">{t("歌手")}<input maxLength={300} value={draft.artist} onChange={(event) => setDraft((old) => ({ ...old, artist: event.target.value }))} className="mt-1.5 block w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm" /></label>
            <label className="text-xs font-semibold">{t("专辑")}<input maxLength={300} value={draft.album} onChange={(event) => setDraft((old) => ({ ...old, album: event.target.value }))} className="mt-1.5 block w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm" /></label>
            <label className="sm:col-span-2 text-xs font-semibold">{t("歌曲语言")}<SelectControl aria-label={t("歌曲语言")} value={draft.language} onChange={(event) => setDraft((old) => ({ ...old, language: event.target.value }))} className="mt-1.5 block w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm"><option value="">{t("未设置")}</option>{ALL_LANGUAGES.map(({ code, label }) => <option key={code} value={code}>{t(label)}</option>)}</SelectControl></label>
          </div>
        </> : null}
        {error && <div role="alert" className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-600">{t(error)} <button type="button" onClick={() => void reload()} disabled={saving} className="ml-2 underline">{t("重新读取")}</button></div>}
        <div className="flex justify-end gap-2 border-t border-[var(--line)] pt-4"><button type="button" onClick={onClose} disabled={saving} className="rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50">{t("取消")}</button><button type="submit" disabled={!song || loading || saving} className="primary-button rounded-xl px-4 py-2 text-sm disabled:opacity-50">{saving ? t("保存中…") : t("保存修改")}</button></div>
      </form>
    </dialog>
  );
}
