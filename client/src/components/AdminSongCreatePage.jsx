import React from 'react';
import { createPortal } from 'react-dom';
import { Check, Disc, UploadCloud, X } from 'lucide-react';
import { ALL_LANGUAGES, getLanguageLabel } from '../constants/language.js';
import { saveSingleSong } from '../utils/singleSongIngest.js';
import { findCatalogDuplicates, findQueueDuplicates } from '../utils/songDuplicateCheck.js';
import { suggestSongLanguage } from '../utils/songLanguageSuggestion.js';
import { createCatalogSong, listCatalogSongs, uploadCatalogMedia } from '../services/catalogAdminApi.js';

const AUDIO_EXTENSIONS = new Set(['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma']);
const COVER_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_WORKER_UPLOAD_BYTES = 100_000_000;
const MAX_QUEUE = 20;
const emptyDraft = () => ({
  id: 'song_' + crypto.randomUUID(), title: '', artist: '', album: '', duration: '', language: '',
});
const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]';
const fileKey = (file) => [file.name, file.size, file.lastModified].join(':');
const statusLabel = {
  reading: '读取中', checking: '查重中', duplicate: '疑似重复',
  ready: '待入库', uploading: '入库中', saved: '已入库', error: '需重试',
};

function CoverThumbnail({ file }) {
  const [url, setUrl] = React.useState('');
  React.useEffect(() => {
    if (!file) { setUrl(''); return undefined; }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]">
    {url ? <img src={url} alt="" className="h-full w-full object-cover" />
      : <Disc size={21} className="text-[var(--muted)]" aria-hidden="true" />}
  </div>;
}

export default function AdminSongCreatePage() {
  const [entries, setEntries] = React.useState([]);
  const [editingId, setEditingId] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [editorError, setEditorError] = React.useState('');
  const [activeUploadId, setActiveUploadId] = React.useState(null);
  const [previewScrollToken, setPreviewScrollToken] = React.useState(0);
  const entriesRef = React.useRef([]);
  const savingRef = React.useRef(false);
  const fileInput = React.useRef(null);
  const previewRef = React.useRef(null);
  const titleInput = React.useRef(null);
  const returnFocus = React.useRef(null);
  const editing = entries.find((entry) => entry.key === editingId);
  const activeUpload = entries.find((entry) => entry.key === activeUploadId);
  const remaining = entries.filter((entry) => entry.status !== 'saved').length;
  const savedCount = entries.length - remaining;
  const hasChecking = entries.some((entry) => ['reading', 'checking'].includes(entry.status));
  const duplicateCount = entries.filter((entry) => entry.duplicateMatches?.length && !entry.allowDuplicate).length;
  const eligibleCount = entries.filter((entry) => entry.status !== 'saved'
    && !['reading', 'checking'].includes(entry.status)
    && (!entry.duplicateMatches?.length || entry.allowDuplicate)).length;

  const commitEntries = (update) => {
    const next = update(entriesRef.current);
    entriesRef.current = next;
    setEntries(next);
  };
  const updateEntry = (key, update) => commitEntries((current) => current.map((entry) =>
    entry.key === key ? update(entry) : entry));

  React.useEffect(() => {
    if (!previewScrollToken) return undefined;
    const frame = requestAnimationFrame(() => previewRef.current?.scrollIntoView({
      behavior: 'smooth', block: 'start',
    }));
    return () => cancelAnimationFrame(frame);
  }, [previewScrollToken]);

  React.useEffect(() => {
    if (!editingId) return undefined;
    const frame = requestAnimationFrame(() => titleInput.current?.focus());
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !savingRef.current) closeEditor();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      returnFocus.current?.focus?.();
    };
  }, [editingId]);

  const openEditor = (key) => {
    if (savingRef.current) return;
    setEditorError('');
    returnFocus.current = document.activeElement;
    setEditingId(key);
  };

  const checkEntry = async (key) => {
    const snapshot = entriesRef.current.find((entry) => entry.key === key);
    if (!snapshot || snapshot.status === 'saved') return { matches: [] };
    const token = (snapshot.checkToken || 0) + 1;
    updateEntry(key, (entry) => ({
      ...entry, checkToken: token, duplicateMatches: [], duplicateState: 'checking', status: 'checking',
      message: '正在检查曲库中是否已有同一首…',
    }));
    try {
      const catalogMatches = await findCatalogDuplicates(snapshot.draft, listCatalogSongs);
      const queueMatches = findQueueDuplicates(snapshot.draft, entriesRef.current, key);
      const matches = [...queueMatches, ...catalogMatches];
      let applied = false;
      updateEntry(key, (entry) => {
        if (entry.checkToken !== token) return entry;
        applied = true;
        return {
          ...entry, duplicateMatches: matches, duplicateState: 'checked',
          status: matches.length && !entry.allowDuplicate ? 'duplicate' : 'ready',
          message: matches.length ? '发现疑似重复，请核对后决定。' : '未发现疑似重复，可入库。',
        };
      });
      return applied ? { matches } : { stale: true };
    } catch (error) {
      updateEntry(key, (entry) => entry.checkToken === token ? ({
        ...entry, duplicateState: 'error', status: 'error',
        message: '查重失败：' + error.message + '。此首尚未上传，可重试。',
      }) : entry);
      return { error };
    }
  };

  const refreshLaterQueueMatches = (startIndex) => commitEntries((current) => current.map((entry, index) => {
    if (index < startIndex || entry.status === 'saved' || entry.duplicateState !== 'checked') return entry;
    const queueMatches = findQueueDuplicates(entry.draft, current, entry.key);
    const matches = [...queueMatches, ...entry.duplicateMatches.filter((match) => match.source === 'catalog')];
    const previousQueue = entry.duplicateMatches.filter((match) => match.source === 'queue');
    const changed = JSON.stringify(previousQueue.map(({ key, strength }) => [key, strength]))
      !== JSON.stringify(queueMatches.map(({ key, strength }) => [key, strength]));
    if (!changed) return entry;
    return {
      ...entry, duplicateMatches: matches, allowDuplicate: false,
      status: matches.length ? 'duplicate' : entry.status === 'error' ? 'error' : 'ready',
      message: matches.length ? '本次清单有变化，请重新核对疑似重复。'
        : entry.status === 'error' ? entry.message : '本次清单有变化，未发现疑似重复。',
    };
  }));

  const closeEditor = () => {
    const entry = entriesRef.current.find((item) => item.key === editingId);
    setEditingId(null);
    if (entry?.duplicateState === 'unchecked') {
      void checkEntry(entry.key);
      refreshLaterQueueMatches(entriesRef.current.findIndex((item) => item.key === entry.key) + 1);
    }
  };

  const readEntry = async (entry) => {
    try {
      const { parseBlob } = await import('music-metadata');
      const metadata = await parseBlob(entry.audioFile, { duration: true });
      const common = metadata.common || {};
      const picture = common.picture?.find((item) => COVER_EXTENSIONS[item.format?.toLowerCase()]);
      const coverFile = picture
        ? new File([picture.data], 'cover.' + COVER_EXTENSIONS[picture.format.toLowerCase()],
          { type: picture.format.toLowerCase() })
        : null;
      const languageGuess = suggestSongLanguage(common);
      updateEntry(entry.key, (current) => ({
        ...current, coverFile, languageGuess, status: 'ready',
        message: '信息已读取。请在预览中核对语言等字段。',
        draft: {
          ...current.draft,
          title: common.title?.trim() || current.draft.title,
          artist: common.artist?.trim() || common.artists?.join('、') || '',
          album: common.album?.trim() || '',
          duration: Number.isFinite(metadata.format?.duration)
            ? String(Math.round(metadata.format.duration)) : '',
          language: languageGuess.code,
        },
      }));
      void checkEntry(entry.key);
    } catch {
      updateEntry(entry.key, (current) => ({
        ...current, status: 'ready',
        message: '未能读取音频标签，已用文件名作为标题；请手动补全。',
      }));
      void checkEntry(entry.key);
    }
  };

  const addFiles = (fileList) => {
    if (savingRef.current) return;
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const known = new Set(entriesRef.current.map((entry) => entry.fileKey));
    const priorCount = entriesRef.current.length;
    const accepted = [];
    const issues = [];
    for (const file of files) {
      const extension = file.name.split('.').at(-1)?.toLowerCase();
      if (!AUDIO_EXTENSIONS.has(extension) || !file.size) {
        issues.push(file.name + '：格式不支持或文件为空');
      } else if (file.size > MAX_WORKER_UPLOAD_BYTES) {
        issues.push(file.name + '：超过单文件 100 MB 限制');
      } else if (known.has(fileKey(file))) {
        issues.push(file.name + '：已在清单中');
      } else if (entriesRef.current.length + accepted.length >= MAX_QUEUE) {
        issues.push('清单最多放入 ' + MAX_QUEUE + ' 首，其余文件未加入');
        break;
      } else {
        const draft = emptyDraft();
        draft.title = file.name.replace(/\.[^.]+$/, '');
        accepted.push({
          key: crypto.randomUUID(), fileKey: fileKey(file), audioFile: file,
          coverFile: null, draft, languageGuess: null, languageEdited: false,
          duplicateMatches: [], duplicateState: 'unchecked', allowDuplicate: false, checkToken: 0,
          uploaded: { audio: null, cover: null },
          status: 'reading', message: '正在读取音频标签…', progress: null,
        });
        known.add(fileKey(file));
      }
    }
    if (accepted.length) {
      commitEntries((current) => [...current, ...accepted]);
      if (priorCount > 0 || accepted.length > 1) setPreviewScrollToken((value) => value + 1);
      void (async () => {
        for (const entry of accepted) await readEntry(entry);
        if (priorCount === 0 && accepted.length === 1 && entriesRef.current.length === 1) {
          openEditor(accepted[0].key);
        }
      })();
    }
    setMessage(issues.length
      ? issues.join('；')
      : '已加入 ' + accepted.length + ' 首音频。请核对预览，必要时点击“编辑”。');
  };

  const removeEntry = (key) => {
    if (savingRef.current) return;
    const removedIndex = entriesRef.current.findIndex((entry) => entry.key === key);
    commitEntries((current) => current.filter((entry) => entry.key !== key));
    if (editingId === key) setEditingId(null);
    refreshLaterQueueMatches(removedIndex);
  };

  const setField = (field, value) => {
    const affectsIdentity = ['title', 'artist', 'album', 'duration'].includes(field);
    updateEntry(editingId, (entry) => ({
      ...entry,
      draft: { ...entry.draft, [field]: value },
      languageEdited: field === 'language' ? true : entry.languageEdited,
      ...(affectsIdentity ? {
        checkToken: entry.checkToken + 1, duplicateState: 'unchecked', duplicateMatches: [],
        allowDuplicate: false, status: 'checking', message: '信息已修改，完成编辑后重新查重。',
      } : {}),
    }));
  };

  const setCover = (file) => {
    if (file && (!COVER_EXTENSIONS[file.type] || !file.size || file.size > MAX_WORKER_UPLOAD_BYTES)) {
      setEditorError('封面须为非空 JPG、PNG 或 WebP 图片，且不超过 100 MB。');
      return;
    }
    setEditorError('');
    updateEntry(editingId, (entry) => ({
      ...entry, coverFile: file, uploaded: { ...entry.uploaded, cover: null },
    }));
  };

  const saveItems = async (onlyId = null) => {
    if (savingRef.current) return;
    const targets = entriesRef.current.filter((entry) =>
      entry.status !== 'saved' && (!onlyId || entry.key === onlyId));
    if (!targets.length) return;
    if (targets.some((entry) => ['reading', 'checking'].includes(entry.status))) {
      setMessage('请等待音频信息读取与查重完成。');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    try {
      for (const target of targets) {
        const current = entriesRef.current.find((entry) => entry.key === target.key);
        if (!current) continue;
        setActiveUploadId(current.key);
        if (!current.draft.title.trim()) {
          updateEntry(current.key, (entry) => ({
            ...entry, status: 'error', message: '请填写歌曲标题。',
          }));
          failed += 1;
          continue;
        }
        if (!current.allowDuplicate) {
          const checked = await checkEntry(current.key);
          if (checked.error || checked.stale) {
            failed += 1;
            continue;
          }
          if (checked.matches.length) {
            skipped += 1;
            continue;
          }
        }
        updateEntry(current.key, (entry) => ({
          ...entry, status: 'uploading', message: '正在准备上传…', progress: null,
        }));
        try {
          await saveSingleSong({
            audioFile: current.audioFile, coverFile: current.coverFile,
            draft: current.draft, uploaded: current.uploaded,
            uploadMedia: (kind, file, onProgress) =>
              uploadCatalogMedia(kind, file, undefined, onProgress),
            createSong: createCatalogSong,
            onUploaded: (uploaded) => updateEntry(current.key, (entry) => ({ ...entry, uploaded })),
            onStage: (stage) => updateEntry(current.key, (entry) => ({
              ...entry, message: stage,
              progress: stage.includes('上传')
                ? { kind: stage.includes('封面') ? 'cover' : 'audio', loaded: 0,
                  total: stage.includes('封面') ? current.coverFile?.size : current.audioFile.size }
                : null,
            })),
            onProgress: (kind, loaded, total) => updateEntry(current.key, (entry) => ({
              ...entry, progress: { kind, loaded, total },
            })),
          });
          updateEntry(current.key, (entry) => ({
            ...entry, status: 'saved', message: '歌曲已加入曲库。', progress: null,
          }));
          completed += 1;
        } catch (error) {
          updateEntry(current.key, (entry) => ({
            ...entry, status: 'error', message: '入库未完成：' + error.message + '。可修改后重试。',
            progress: null,
          }));
          failed += 1;
        }
      }
      setMessage('本次已入库 ' + completed + ' 首'
        + (skipped ? '，跳过疑似重复 ' + skipped + ' 首' : '')
        + (failed ? '，失败 ' + failed + ' 首，可重试' : '') + '。');
    } finally {
      savingRef.current = false;
      setSaving(false);
      setActiveUploadId(null);
    }
  };

  const activeProgress = activeUpload?.progress;
  const activePercent = activeProgress?.total
    ? Math.min(100, Math.round(activeProgress.loaded / activeProgress.total * 100)) : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-24 text-[var(--ink)]">
      <div>
        <h1 className="text-3xl font-black tracking-tight sm:text-4xl">新增歌曲</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">选择或拖入音频，先预览并修正，再按顺序入库。</p>
      </div>

      <div className="rounded-3xl border border-[var(--line)] bg-[var(--surface-raised)] p-5 shadow-xs">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold">音频文件</h2>
          {entries.length > 0 && <span className="text-xs text-[var(--muted)]">已入库 {savedCount} / {entries.length}</span>}
        </div>
        <div
          className={'mt-3 rounded-2xl border-2 border-dashed px-6 py-5 text-center transition-colors ' +
            (dragging ? 'border-[var(--accent)] bg-[var(--surface)]' : 'border-[var(--line)]')}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            addFiles(event.dataTransfer.files);
          }}
        >
          <UploadCloud className="mx-auto text-[var(--accent)]" size={28} aria-hidden="true" />
          <p className="mt-2 text-sm font-semibold">拖入一首或多首音频</p>
          <p className="mt-1 text-xs text-[var(--muted)]">最多 20 首；MP3、FLAC、WAV、OGG、M4A、AAC、WMA；单文件不超过 100 MB</p>
          <button type="button" disabled={saving} onClick={() => fileInput.current?.click()}
            className="primary-button mt-4 rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-50">
            选择音频文件
          </button>
          <input ref={fileInput} type="file" multiple accept=".mp3,.flac,.wav,.ogg,.m4a,.aac,.wma" className="sr-only"
            onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />
        </div>
      </div>

      {message && <p role="status" className="rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-4 py-3 text-sm">{message}</p>}

      {entries.length > 0 && <section ref={previewRef}
        className="scroll-mt-5 rounded-3xl border border-[var(--line)] bg-[var(--surface-raised)] p-4 shadow-xs sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">入库预览</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              语言建议和疑似重复均可核对。{duplicateCount ? duplicateCount + ' 首疑似重复默认跳过。' : ''}
            </p>
          </div>
          <button type="button" disabled={saving || hasChecking || eligibleCount === 0}
            onClick={() => void saveItems()}
            className="primary-button rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-50">
            {saving ? '正在依次入库…' : '入库可处理歌曲（' + eligibleCount + '）'}
          </button>
        </div>

        {activeUpload && <div className="mt-4 rounded-xl bg-[var(--surface)] px-4 py-3">
          <p className="text-sm font-medium">正在处理：{activeUpload.draft.title}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">{activeUpload.message}</p>
          {activeProgress && <div className="mt-2">
            <div className="mb-1 flex justify-between text-xs text-[var(--muted)]">
              <span>{activeProgress.kind === 'cover' ? '封面上传' : '音频上传'}</span>
              <span>{activePercent}%</span>
            </div>
            <div role="progressbar" aria-label="当前媒体上传进度" aria-valuemin="0" aria-valuemax="100"
              aria-valuenow={activePercent} className="h-2 overflow-hidden rounded-full bg-[var(--line)]">
              <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150"
                style={{ width: activePercent + '%' }} />
            </div>
          </div>}
        </div>}

        <div className="mt-4 space-y-2">
          {entries.map((entry, index) => {
            const source = entry.languageEdited ? '人工修改'
              : entry.languageGuess?.source === 'tag' ? '标签'
                : entry.languageGuess?.source === 'text' ? '文字推测' : '待确认';
            const percent = entry.progress?.total
              ? Math.min(100, Math.round(entry.progress.loaded / entry.progress.total * 100)) : 0;
            return <article key={entry.key}
              className="flex flex-wrap items-start gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3 sm:flex-nowrap sm:p-4">
              <CoverThumbnail file={entry.coverFile} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold" title={entry.draft.title}>
                  {index + 1}. {entry.draft.title}
                </p>
                <p className="mt-1 truncate text-xs text-[var(--muted)]">
                  {entry.draft.artist || '歌手未设置'} · {entry.draft.album || '专辑未设置'}
                  {entry.draft.duration ? ' · ' + Math.floor(Number(entry.draft.duration) / 60) + ':' +
                    String(Number(entry.draft.duration) % 60).padStart(2, '0') : ''}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full border border-[var(--line)] px-2 py-0.5">
                    {getLanguageLabel(entry.draft.language, '语言未设置')} · {source}
                  </span>
                  <span className="text-[var(--muted)]">
                    {entry.status === 'saved' && <Check size={12} className="mr-1 inline text-[var(--accent)]" />}
                    {statusLabel[entry.status]}{entry.status === 'uploading' && entry.progress ? ' · ' + percent + '%' : ''}
                  </span>
                </div>
                {(entry.status === 'error' || entry.status === 'uploading') &&
                  <p role="status" className="mt-2 text-xs text-[var(--muted)]">{entry.message}</p>}
                {entry.duplicateState === 'error' && !entry.allowDuplicate && !saving && <button type="button"
                  className="mt-2 rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs font-semibold"
                  onClick={() => updateEntry(entry.key, (current) => ({
                    ...current, allowDuplicate: true, status: 'ready',
                    message: '已确认忽略查重结果并继续入库。',
                  }))}>
                  忽略查重并入库
                </button>}
                {entry.duplicateState === 'error' && entry.allowDuplicate &&
                  <p className="mt-2 text-xs text-[var(--muted)]">查重未完成 · 已人工放行</p>}
                {entry.duplicateMatches?.length > 0 && <div role="alert"
                  className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                  <p className="font-semibold">发现 {entry.duplicateMatches.length} 项疑似重复{entry.allowDuplicate ? ' · 已人工放行' : ' · 默认跳过'}</p>
                  {entry.duplicateMatches.slice(0, 3).map((match) =>
                    <p key={match.source + (match.id || match.key)} className="mt-1 truncate" title={match.title}>
                      {match.source === 'catalog' ? '曲库已有' : '本次清单'}：{match.title}
                      {' · ' + (match.artist || '歌手未设置')}
                      {match.duration ? ' · ' + match.duration + ' 秒' : ''}
                      {match.strength === 'possible' ? ' · 可能不同版本' : ''}
                    </p>)}
                  {entry.duplicateMatches.length > 3 && <p className="mt-1">另有 {entry.duplicateMatches.length - 3} 项匹配</p>}
                  {entry.status !== 'saved' && !saving && <button type="button"
                    className="mt-2 rounded-lg border border-amber-500/50 px-2.5 py-1 font-semibold"
                    onClick={() => updateEntry(entry.key, (current) => ({
                      ...current, allowDuplicate: !current.allowDuplicate,
                      status: current.allowDuplicate ? 'duplicate' : 'ready',
                      message: current.allowDuplicate ? '疑似重复，默认跳过。' : '已确认仍要入库。',
                    }))}>
                    {entry.allowDuplicate ? '撤销放行' : '仍要入库'}
                  </button>}
                </div>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" disabled={saving || entry.status === 'reading' || entry.status === 'saved'}
                  onClick={() => openEditor(entry.key)}
                  className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
                  编辑
                </button>
                <button type="button" disabled={saving || ['reading', 'checking', 'saved'].includes(entry.status)
                  || (entry.duplicateMatches?.length > 0 && !entry.allowDuplicate)}
                  onClick={() => void saveItems(entry.key)}
                  className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
                  {entry.status === 'error' ? '重试' : '入库'}
                </button>
                {!saving && <button type="button" onClick={() => removeEntry(entry.key)}
                  aria-label={'从清单移除 ' + entry.draft.title}
                  className="rounded-lg p-1.5 text-[var(--muted)] hover:text-[var(--ink)]"><X size={15} /></button>}
              </div>
            </article>;
          })}
        </div>
      </section>}

      {editing && createPortal(<>
        <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-xs"
          onClick={() => { if (!saving) closeEditor(); }} />
        <section role="dialog" aria-modal="true" aria-label={'编辑 ' + editing.draft.title}
          className="fixed left-1/2 top-1/2 z-[101] flex max-h-[min(88dvh,760px)] w-[min(92vw,620px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] shadow-2xl">
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-4">
            <div>
              <h2 className="text-base font-bold">编辑歌曲信息</h2>
              <p className="mt-0.5 text-xs text-[var(--muted)]">修改会更新预览，点击入库后才上传。</p>
            </div>
            <button type="button" onClick={closeEditor} aria-label="关闭编辑窗"
              className="rounded-lg p-2 text-[var(--muted)] hover:text-[var(--ink)]"><X size={18} /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {editorError && <p role="alert" className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm">{editorError}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium sm:col-span-2">歌曲标题 <span aria-hidden="true">*</span>
                <input ref={titleInput} className={inputClass + ' mt-1.5'} value={editing.draft.title}
                  onChange={(event) => setField('title', event.target.value)} /></label>
              <label className="text-sm font-medium">歌手
                <input className={inputClass + ' mt-1.5'} value={editing.draft.artist}
                  onChange={(event) => setField('artist', event.target.value)} /></label>
              <label className="text-sm font-medium">专辑
                <input className={inputClass + ' mt-1.5'} value={editing.draft.album}
                  onChange={(event) => setField('album', event.target.value)} /></label>
              <label className="text-sm font-medium">时长（秒）
                <input className={inputClass + ' mt-1.5'} type="number" min="0" max="86400" step="1"
                  value={editing.draft.duration}
                  onChange={(event) => setField('duration', event.target.value)} /></label>
              <label className="text-sm font-medium">歌曲语言
                <select className={inputClass + ' mt-1.5'} value={editing.draft.language}
                  onChange={(event) => setField('language', event.target.value)}>
                  <option value="">未设置</option>
                  {ALL_LANGUAGES.map(({ code, label }) => <option key={code} value={code}>{label}</option>)}
                </select>
                <span className="mt-1 block text-xs text-[var(--muted)]">
                  {editing.languageEdited ? '已人工修改'
                    : editing.languageGuess?.reason || '未能从音频标签判断语言'}
                </span>
              </label>
            </div>
            <div className="border-t border-[var(--line)] pt-5">
              <h3 className="mb-3 text-sm font-bold">封面</h3>
              <div className="flex items-start gap-4">
                <CoverThumbnail file={editing.coverFile} />
                <div className="min-w-0 space-y-2">
                  <p className="text-xs text-[var(--muted)]">优先读取内嵌封面，也可替换。</p>
                  <label className="inline-flex cursor-pointer rounded-lg border border-[var(--line)] px-3 py-2 text-xs font-semibold">
                    选择封面图片
                    <input type="file" accept=".jpg,.jpeg,.png,.webp" className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) setCover(file);
                        event.target.value = '';
                      }} />
                  </label>
                  {editing.coverFile && <button type="button" onClick={() => setCover(null)}
                    className="block text-xs text-[var(--muted)] hover:text-[var(--ink)]">移除封面</button>}
                </div>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 justify-end border-t border-[var(--line)] bg-[var(--surface-raised)] px-5 py-4">
            <button type="button" onClick={closeEditor}
              className="primary-button rounded-xl px-5 py-2.5 text-sm font-semibold">完成编辑</button>
          </div>
        </section>
      </>, document.body)}
    </div>
  );
}
