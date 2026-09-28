import { t } from '../i18n/index.js';
import React from 'react';
import { createPortal } from 'react-dom';
import { Check, Disc, UploadCloud, X } from 'lucide-react';
import { ALL_LANGUAGES, getLanguageLabel } from '../constants/language.js';
import { saveSingleSong } from '../utils/singleSongIngest.js';
import { catalogSaveApplied } from '../utils/catalogSaveVerification.js';
import { compareSongIdentity, duplicateReviewSignature, findCatalogDuplicates, findQueueDuplicates } from '../utils/songDuplicateCheck.js';
import { suggestSongLanguage } from '../utils/songLanguageSuggestion.js';
import { resolveDeviceLanguage } from '../utils/deviceFolderLanguage.js';
import { createCatalogSong, getCatalogSong, listCatalogSongs, updateCatalogSong, uploadCatalogMedia } from '../services/catalogAdminApi.js';
import { hydrateSong } from '../utils.js';
import { rejectDuplicateDecisionAfterCheckFailure } from '../utils/duplicateIngestDecision.js';
import IngestDeviceSource from './IngestDeviceSource.jsx';
import PrivateCoverImage from './PrivateCoverImage.jsx';
import { runDeviceJob } from '../services/ingestDeviceApi.js';

const AUDIO_EXTENSIONS = new Set(['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma']);
const COVER_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_WORKER_UPLOAD_BYTES = 100_000_000;
const MAX_QUEUE = 500;
const MAX_BROWSER_QUEUE = 20;
const PREVIEW_PAGE_SIZE = 25;
const emptyDraft = () => ({
  id: 'song_' + crypto.randomUUID(), title: '', artist: '', album: '', duration: '', language: '',
});
const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]';
const fileKey = (file) => [file.name, file.size, file.lastModified].join(':');
const statusLabel = {
  reading: '读取中', checking: '查重中', duplicate: '疑似重复',
  ready: '待入库', uploading: '入库中', saved: '已入库', error: '需重试',
};

function CoverThumbnail({ file, previewUrl = '' }) {
  const [url, setUrl] = React.useState('');
  React.useEffect(() => {
    if (!(file instanceof Blob)) { setUrl(''); return undefined; }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]">
    {url || previewUrl ? <PrivateCoverImage src={url || previewUrl} alt="" className="h-full w-full object-cover" />
      : <Disc size={21} className="text-[var(--muted)]" aria-hidden="true" />}
  </div>;
}

function LocalAudioPreview({ file }) {
  const [url, setUrl] = React.useState('');
  React.useEffect(() => {
    if (!(file instanceof Blob)) return undefined;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? <audio controls preload="none" src={url} className="mt-2 w-full" aria-label={t("试听本次文件")} /> : null;
}

export default function AdminSongCreatePage() {
  const [entries, setEntries] = React.useState([]);
  const [editingId, setEditingId] = React.useState(null);
  const [reviewingId, setReviewingId] = React.useState(null);
  const [reviewChoice, setReviewChoice] = React.useState('skip');
  const [saving, setSaving] = React.useState(false);
  const [batchSaving, setBatchSaving] = React.useState(false);
  const [pauseRequested, setPauseRequested] = React.useState(false);
  const [pausedKeys, setPausedKeys] = React.useState([]);
  const [dragging, setDragging] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [editorError, setEditorError] = React.useState('');
  const [activeUploadId, setActiveUploadId] = React.useState(null);
  const [view, setView] = React.useState('source');
  const [source, setSource] = React.useState('browser');
  const [loadingCoverId, setLoadingCoverId] = React.useState(null);
  const [previewQuery, setPreviewQuery] = React.useState('');
  const [previewStatus, setPreviewStatus] = React.useState('all');
  const [previewLanguage, setPreviewLanguage] = React.useState('all');
  const [previewPage, setPreviewPage] = React.useState(1);
  const entriesRef = React.useRef([]);
  const savingRef = React.useRef(false);
  const pauseRequestedRef = React.useRef(false);
  const fileInput = React.useRef(null);
  const titleInput = React.useRef(null);
  const returnFocus = React.useRef(null);
  const editing = entries.find((entry) => entry.key === editingId);
  const reviewing = entries.find((entry) => entry.key === reviewingId);
  const activeUpload = entries.find((entry) => entry.key === activeUploadId);
  const remaining = entries.filter((entry) => entry.status !== 'saved').length;
  const savedCount = entries.length - remaining;
  const hasChecking = entries.some((entry) => entry.selected !== false && ['reading', 'checking'].includes(entry.status));
  const duplicateCount = entries.filter((entry) => entry.reviewStale
    || (entry.duplicateMatches?.length && !entry.allowDuplicate)).length;
  const eligibleCount = entries.filter((entry) => entry.selected !== false && entry.status !== 'saved'
    && !['reading', 'checking'].includes(entry.status)
    && !entry.reviewStale && (!entry.duplicateMatches?.length || entry.allowDuplicate)).length;
  const pausedRemainingCount = entries.filter((entry) => pausedKeys.includes(entry.key)
    && entry.selected !== false && entry.status !== 'saved').length;
  const previewRows = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => {
    const query = previewQuery.trim().toLocaleLowerCase();
    if (query && ![entry.draft.title, entry.draft.artist, entry.draft.album, entry.agent?.path]
      .some((part) => String(part || '').toLocaleLowerCase().includes(query))) return false;
    if (previewLanguage !== 'all' && entry.draft.language !== previewLanguage) return false;
    if (previewStatus === 'duplicate') return Boolean(entry.reviewStale || entry.duplicateMatches?.length);
    if (previewStatus === 'selected') return entry.selected !== false && entry.status !== 'saved';
    if (previewStatus === 'pending') return entry.status !== 'saved' && entry.status !== 'error';
    return previewStatus === 'all' || entry.status === previewStatus;
  });
  const previewPageCount = Math.max(1, Math.ceil(previewRows.length / PREVIEW_PAGE_SIZE));
  const shownPreviewRows = previewRows.slice((previewPage - 1) * PREVIEW_PAGE_SIZE,
    previewPage * PREVIEW_PAGE_SIZE);
  React.useEffect(() => {
    setPreviewPage((current) => Math.min(current, previewPageCount));
  }, [previewPageCount]);

  const commitEntries = (update) => {
    const next = update(entriesRef.current);
    entriesRef.current = next;
    setEntries(next);
  };
  const updateEntry = (key, update) => commitEntries((current) => current.map((entry) =>
    entry.key === key ? update(entry) : entry));

  const showView = (nextView) => {
    setView(nextView);
  };

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

  React.useEffect(() => {
    if (!reviewingId) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') setReviewingId(null); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [reviewingId]);

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
      const queueMatches = findQueueDuplicates(snapshot.draft,
        entriesRef.current.filter((entry) => entry.selected !== false), key);
      const matches = [...queueMatches, ...catalogMatches];
      let applied = false;
      updateEntry(key, (entry) => {
        if (entry.checkToken !== token) return entry;
        applied = true;
        const choiceStillMatches = duplicateReviewSignature(snapshot.duplicateMatches) === duplicateReviewSignature(matches);
        const allowDuplicate = choiceStillMatches && entry.allowDuplicate;
        const reviewStale = entry.reviewStale || (entry.allowDuplicate && !choiceStillMatches);
        return {
          ...entry, duplicateMatches: matches, duplicateState: 'checked',
          allowDuplicate, replaceTarget: allowDuplicate ? entry.replaceTarget : null, reviewStale,
          status: reviewStale || matches.length && !allowDuplicate ? 'duplicate' : 'ready',
          message: reviewStale ? '匹配结果已变化，请重新核对。'
            : matches.length ? '发现疑似重复，请核对后决定。' : '未发现疑似重复，可入库。',
        };
      });
      return applied ? { matches } : { stale: true };
    } catch (error) {
      updateEntry(key, (entry) => entry.checkToken === token
        ? rejectDuplicateDecisionAfterCheckFailure(entry, error) : entry);
      return { error };
    }
  };

  const refreshLaterQueueMatches = (startIndex) => commitEntries((current) => current.map((entry, index) => {
    if (index < startIndex || entry.status === 'saved' || entry.duplicateState !== 'checked') return entry;
    const queueMatches = findQueueDuplicates(entry.draft,
      current.filter((item) => item.selected !== false), entry.key);
    const matches = [...queueMatches, ...entry.duplicateMatches.filter((match) => match.source === 'catalog')];
    const previousQueue = entry.duplicateMatches.filter((match) => match.source === 'queue');
    const changed = duplicateReviewSignature(previousQueue) !== duplicateReviewSignature(queueMatches);
    if (!changed) return entry;
    return {
      ...entry, duplicateMatches: matches, allowDuplicate: false, replaceTarget: null,
      reviewStale: entry.reviewStale || entry.allowDuplicate,
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
        issues.push(t('{file}：格式不支持或文件为空', { file: file.name }));
      } else if (file.size > MAX_WORKER_UPLOAD_BYTES) {
        issues.push(t('{file}：超过单文件 100 MB 限制', { file: file.name }));
      } else if (known.has(fileKey(file))) {
        issues.push(t('{file}：已在清单中', { file: file.name }));
      } else if (entriesRef.current.filter((entry) => !entry.agent).length + accepted.length >= MAX_BROWSER_QUEUE
        || entriesRef.current.length + accepted.length >= MAX_QUEUE) {
        issues.push(t('浏览器文件最多放入 20 首，整个清单最多 500 首，其余文件未加入'));
        break;
      } else {
        const draft = emptyDraft();
        draft.title = file.name.replace(/\.[^.]+$/, '');
        accepted.push({
          key: crypto.randomUUID(), fileKey: fileKey(file), audioFile: file, selected: true,
          coverFile: null, draft, languageGuess: null, languageEdited: false,
          duplicateMatches: [], duplicateState: 'unchecked', allowDuplicate: false, replaceTarget: null, reviewStale: false, checkToken: 0,
          uploaded: { audio: null, cover: null },
          status: 'reading', message: '正在读取音频标签…', progress: null,
        });
        known.add(fileKey(file));
      }
    }
    if (accepted.length) {
      commitEntries((current) => [...current, ...accepted]);
      setPausedKeys((current) => current.length
        ? [...current, ...accepted.map((entry) => entry.key)] : current);
      showView('queue');
      void (async () => {
        for (const entry of accepted) await readEntry(entry);
        if (priorCount === 0 && accepted.length === 1 && entriesRef.current.length === 1) {
          openEditor(accepted[0].key);
        }
      })();
    }
    setMessage(issues.length
      ? issues.join(t('；'))
      : t('已加入 {count} 首音频。请核对预览，必要时点击“编辑”。', { count: accepted.length }));
  };

  const addDeviceFiles = (files, device, folderMappings = {}) => {
    if (savingRef.current) return;
    const known = new Set(entriesRef.current.map((entry) => entry.fileKey));
    const added = [];
    for (const file of files) {
      if (entriesRef.current.length + added.length >= MAX_QUEUE) break;
      const identity = `device:${device.id}:${file.id}`;
      if (known.has(identity)) continue;
      const common = file.common || {};
      const languageGuess = resolveDeviceLanguage(file, folderMappings);
      const audioFile = { name: file.name, size: file.size, lastModified: file.lastModified };
      const coverFile = file.cover ? { ...file.cover, agent: true } : null;
      added.push({
        key: crypto.randomUUID(), fileKey: identity, agent: { deviceId: device.id, fileId: file.id,
          deviceName: device.name, path: file.path }, audioFile, coverFile, coverPreviewUrl: '',
        draft: { ...emptyDraft(), title: common.title?.trim() || file.name.replace(/\.[^.]+$/, ''),
          artist: common.artist?.trim() || common.artists?.join('、') || '',
          album: common.album?.trim() || '', duration: file.duration || '',
          language: languageGuess.code },
        selected: true, languageGuess, languageEdited: false,
        deviceJobs: {},
        duplicateMatches: [], duplicateState: 'unchecked', allowDuplicate: false,
        replaceTarget: null, reviewStale: false, checkToken: 0,
        uploaded: { audio: null, cover: null }, status: 'ready',
        message: '来自本地设备，等待核对。', progress: null,
      });
      known.add(identity);
    }
    if (!added.length) { setMessage(t("所选歌曲已在入库清单中，或清单已满。")); return; }
    commitEntries((current) => [...current, ...added]);
    setPausedKeys((current) => current.length
      ? [...current, ...added.map((entry) => entry.key)] : current);
    showView('queue');
    setMessage(t("已从“{p0}”加入 {p1} 首，请核对并勾选要入库的歌曲。", { p0: (device.name), p1: (added.length) }));
    void (async () => { for (const entry of added) await checkEntry(entry.key); })();
  };

  const loadDeviceCover = async (entry) => {
    if (!entry.agent || !entry.coverFile || loadingCoverId) return;
    setLoadingCoverId(entry.key);
    try {
      const job = await runDeviceJob(entry.agent.deviceId,
        { kind: 'cover', fileId: entry.agent.fileId }, {
          jobId: entry.deviceJobs?.cover,
          onJob: (created) => updateEntry(entry.key, (current) => ({
            ...current, deviceJobs: { ...current.deviceJobs, cover: created.id },
          })),
        });
      updateEntry(entry.key, (current) => ({
        ...current, coverPreviewUrl: job.url,
        uploaded: { ...current.uploaded, cover: { file: current.coverFile, url: job.url } },
      }));
    } catch (error) { setMessage(t('读取封面失败：{reason}', { reason: t(error.message) })); }
    finally { setLoadingCoverId(null); }
  };

  const removeEntry = (key) => {
    if (savingRef.current) return;
    const removedIndex = entriesRef.current.findIndex((entry) => entry.key === key);
    commitEntries((current) => current.filter((entry) => entry.key !== key));
    setPausedKeys((current) => current.filter((item) => item !== key));
    if (entriesRef.current.length === 0) setView('source');
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
        allowDuplicate: false, replaceTarget: null, reviewStale: false, status: 'checking', message: '信息已修改，完成编辑后重新查重。',
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
      ...entry, coverFile: file, coverPreviewUrl: '',
      uploaded: { ...entry.uploaded, cover: null },
    }));
  };

  const openReview = async (key) => {
    if (savingRef.current) return;
    const checked = await checkEntry(key);
    if (checked.error || checked.stale) return;
    const current = entriesRef.current.find((entry) => entry.key === key);
    if (!checked.matches?.length && !current?.reviewStale) return;
    setReviewChoice(current?.replaceTarget ? `replace:${current.replaceTarget.id}`
      : current?.allowDuplicate ? 'add' : 'skip');
    setReviewingId(key);
  };

  const confirmReview = () => {
    const entry = entriesRef.current.find((item) => item.key === reviewingId);
    if (!entry) return;
    const selected = reviewChoice.startsWith('replace:')
      ? entry.duplicateMatches.find((match) => match.source === 'catalog' && match.id === reviewChoice.slice(8)) : null;
    if (reviewChoice.startsWith('replace:') && (!selected || !selected.version)) {
      setMessage(t("替换目标已变化，请重新核对。"));
      setReviewingId(null);
      return;
    }
    updateEntry(entry.key, (current) => ({ ...current,
      allowDuplicate: reviewChoice !== 'skip', replaceTarget: selected,
      reviewStale: reviewChoice === 'skip' && !current.duplicateMatches.length,
      status: reviewChoice === 'skip' ? 'duplicate' : 'ready',
      message: reviewChoice === 'skip' ? current.duplicateMatches.length ? '疑似重复，默认跳过。' : '替换目标变化，尚未选择处理方式。'
        : selected ? '将替换曲库歌曲《{title}》。' : '将新增另一版本。',
      messageValues: selected ? { title: selected.title } : undefined,
    }));
    setReviewingId(null);
  };

  const saveItems = async (onlyId = null, resumePaused = false) => {
    if (savingRef.current) return;
    const resumeKeys = resumePaused ? new Set(pausedKeys) : null;
    const targets = entriesRef.current.filter((entry) =>
      entry.status !== 'saved' && (!onlyId || entry.key === onlyId)
      && (onlyId || entry.selected !== false)
      && (!resumeKeys || resumeKeys.has(entry.key)));
    if (!targets.length) return;
    if (targets.some((entry) => ['reading', 'checking'].includes(entry.status))) {
      setMessage(t("请等待音频信息读取与查重完成。"));
      return;
    }
    savingRef.current = true;
    pauseRequestedRef.current = false;
    setSaving(true);
    setMessage('');
    setBatchSaving(!onlyId);
    setPauseRequested(false);
    setPausedKeys((current) => onlyId ? current.filter((key) => key !== onlyId) : []);
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let pausedAt = targets.length;
    try {
      for (let index = 0; index < targets.length; index += 1) {
        if (!onlyId && pauseRequestedRef.current) {
          pausedAt = index;
          break;
        }
        const target = targets[index];
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
        try {
          const checked = current.duplicateState === 'error' && current.allowDuplicate && !current.replaceTarget
            ? { matches: [] } : await checkEntry(current.key);
          if (checked.error || checked.stale) { failed += 1; continue; }
          const confirmed = entriesRef.current.find((entry) => entry.key === current.key);
          if (confirmed.reviewStale) { skipped += 1; continue; }
          if (checked.matches.length && !confirmed.allowDuplicate) { skipped += 1; continue; }
          let replaceTarget = null;
          if (confirmed.replaceTarget) {
            const match = checked.matches.find((item) => item.source === 'catalog'
              && item.id === confirmed.replaceTarget.id && item.version === confirmed.replaceTarget.version);
            if (!match) throw new Error('替换目标已变化，请重新核对');
            replaceTarget = (await getCatalogSong(match.id)).song;
            if (!replaceTarget || replaceTarget.version !== match.version
              || !compareSongIdentity(confirmed.draft, replaceTarget)) {
              throw new Error('替换目标已变化，请重新核对');
            }
          }
          updateEntry(current.key, (entry) => ({
            ...entry, status: 'uploading', message: '正在准备上传…', progress: null,
          }));
          await saveSingleSong({
            audioFile: current.audioFile, coverFile: current.coverFile,
            draft: current.draft, uploaded: current.uploaded,
            uploadMedia: async (kind, file, onProgress) => {
              if (current.agent && !(file instanceof File)) {
                const latest = entriesRef.current.find((entry) => entry.key === current.key);
                const job = await runDeviceJob(current.agent.deviceId,
                  { kind, fileId: current.agent.fileId }, {
                    jobId: latest?.deviceJobs?.[kind],
                    onJob: (created) => updateEntry(current.key, (entry) => ({
                      ...entry, deviceJobs: { ...entry.deviceJobs, [kind]: created.id },
                    })),
                    onProgress: (progress) => {
                      if (progress?.kind !== kind) return;
                      updateEntry(current.key, (entry) => ({ ...entry,
                        progress: { kind, loaded: progress.loaded, total: progress.total },
                      }));
                    },
                  });
                return { url: job.url };
              }
              return uploadCatalogMedia(kind, file, undefined, onProgress);
            },
            createSong: createCatalogSong,
            replaceTarget, updateSong: updateCatalogSong,
            onUploaded: (uploaded) => updateEntry(current.key, (entry) => ({ ...entry, uploaded })),
            onStage: (stage) => updateEntry(current.key, (entry) => ({
              ...entry, message: current.agent && stage.includes('上传')
                ? stage.replace('正在上传', '设备正在上传') : stage,
              progress: !current.agent && stage.includes('上传')
                ? { kind: stage.includes('封面') ? 'cover' : 'audio', loaded: 0,
                  total: stage.includes('封面') ? current.coverFile?.size : current.audioFile.size }
                : null,
            })),
            onProgress: (kind, loaded, total) => updateEntry(current.key, (entry) => ({
              ...entry, progress: { kind, loaded, total },
            })),
          });
          updateEntry(current.key, (entry) => ({
            ...entry, status: 'saved', message: replaceTarget ? '已替换曲库歌曲。' : '歌曲已加入曲库。', progress: null,
          }));
          completed += 1;
        } catch (error) {
          const latest = entriesRef.current.find((entry) => entry.key === current.key);
          const savedAudioUrl = latest?.uploaded?.audio?.url;
          const targetId = latest?.replaceTarget?.id || current.draft.id;
          const recovery = savedAudioUrl ? await getCatalogSong(targetId).catch(() => null) : null;
          if (catalogSaveApplied(current.draft, recovery?.song, { audioUrl: savedAudioUrl,
            coverUrl: latest?.uploaded?.cover?.url, hasNewCover: Boolean(current.coverFile),
            keepExistingCover: Boolean(latest?.replaceTarget) })) {
            updateEntry(current.key, (entry) => ({ ...entry, status: 'saved',
              message: latest?.replaceTarget ? '已替换曲库歌曲。' : '歌曲已加入曲库。', progress: null }));
            completed += 1;
            continue;
          }
          updateEntry(current.key, (entry) => ({
            ...entry, status: 'error', message: t('入库未完成：{reason}。可修改后重试。', { reason: t(error.message) }),
            ...(error.message.includes('替换目标已变化') || current.replaceTarget && error.status === 409
              ? { allowDuplicate: false, replaceTarget: null, reviewStale: true } : {}),
            progress: null,
          }));
          failed += 1;
        }
      }
      const remainingTargets = targets.slice(pausedAt);
      if (remainingTargets.length) setPausedKeys(remainingTargets.map((entry) => entry.key));
      setMessage(t('本次已入库 {count} 首', { count: completed })
        + (skipped ? t('，跳过疑似重复 {count} 首', { count: skipped }) : '')
        + (failed ? t('，失败 {count} 首，可单独重试', { count: failed }) : '')
        + (remainingTargets.length ? t('；已暂停，剩余 {count} 首未处理', { count: remainingTargets.length }) : '') + t('。'));
    } finally {
      savingRef.current = false;
      pauseRequestedRef.current = false;
      setSaving(false);
      setBatchSaving(false);
      setPauseRequested(false);
      setActiveUploadId(null);
    }
  };

  const pauseBatch = () => {
    if (!savingRef.current || !batchSaving || pauseRequestedRef.current) return;
    pauseRequestedRef.current = true;
    setPauseRequested(true);
  };

  const activeProgress = activeUpload?.progress;
  const activePercent = activeProgress?.total
    ? Math.min(100, Math.round(activeProgress.loaded / activeProgress.total * 100)) : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-24 text-[var(--ink)]">
      <div>
        <h1 className="text-3xl font-black tracking-tight sm:text-4xl">{t("歌曲入库")}</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">{t("先选歌，再在同一清单中核对与入库。")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label={t("歌曲入库步骤")}>
        <button type="button" aria-pressed={view === 'source'} disabled={saving}
          onClick={() => showView('source')}
          className={'rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50 ' +
            (view === 'source' ? 'primary-button' : 'border border-[var(--line)] bg-[var(--surface-raised)]')}>{t("选歌")}</button>
        <button type="button" aria-pressed={view === 'queue'} disabled={!entries.length}
          onClick={() => showView('queue')}
          className={'rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50 ' +
            (view === 'queue' ? 'primary-button' : 'border border-[var(--line)] bg-[var(--surface-raised)]')}>{t('入库清单（{count}）', { count: entries.length })}
        </button>
        {entries.length > 0 && <span className="ml-auto text-xs text-[var(--muted)]">{t("已入库")}{' '}{savedCount} / {entries.length}</span>}
      </div>

      <div hidden={view !== 'source'}>
      <div className="rounded-3xl border border-[var(--line)] bg-[var(--surface-raised)] p-5 shadow-xs">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold">{t("选择歌曲来源")}</h2>
        </div>
        <div className="mt-4 flex gap-2" role="tablist" aria-label={t("歌曲来源")}>
          <button type="button" role="tab" aria-selected={source === 'browser'}
            onClick={() => setSource('browser')}
            className={'rounded-xl px-4 py-2 text-sm font-semibold ' +
              (source === 'browser' ? 'primary-button' : 'border border-[var(--line)]')}>{t("此设备文件")}</button>
          <button type="button" role="tab" aria-selected={source === 'device'}
            onClick={() => setSource('device')}
            className={'rounded-xl px-4 py-2 text-sm font-semibold ' +
              (source === 'device' ? 'primary-button' : 'border border-[var(--line)]')}>{t("已连接设备目录")}</button>
        </div>
        {source === 'device' ? <div className="mt-4"><IngestDeviceSource disabled={saving} onAdd={addDeviceFiles} /></div> : <div
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
          <p className="mt-2 text-sm font-semibold">{t("拖入一首或多首音频")}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">{t("最多 20 首；MP3、FLAC、WAV、OGG、M4A、AAC、WMA；单文件不超过 100 MB")}</p>
          <button type="button" disabled={saving} onClick={() => fileInput.current?.click()}
            className="primary-button mt-4 rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-50">{t("选择音频文件")}</button>
          <input ref={fileInput} type="file" multiple accept=".mp3,.flac,.wav,.ogg,.m4a,.aac,.wma" className="sr-only"
            onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />
        </div>}
      </div>
      {message && <p role="status" className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-4 py-3 text-sm">{t(message)}</p>}
      </div>

      {entries.length > 0 && <section hidden={view !== 'queue'}
        className="rounded-3xl border border-[var(--line)] bg-[var(--surface-raised)] p-4 shadow-xs sm:p-6">
        <div className="sticky top-0 z-20 -mx-4 -mt-4 border-b border-[var(--line)] bg-[var(--surface-raised)] px-4 py-3 sm:-mx-6 sm:-mt-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">{t("入库清单")}</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">{t("语言建议和疑似重复均可核对。")}{duplicateCount ? t('{count} 首疑似重复默认跳过。', { count: duplicateCount }) : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {saving ? batchSaving ? <button type="button" disabled={pauseRequested} onClick={pauseBatch}
              className="rounded-xl border border-[var(--line)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
              {pauseRequested ? t("当前歌曲完成后暂停…") : t("暂停入库")}
            </button> : <span className="text-sm text-[var(--muted)]">{t("正在入库…")}</span>
              : <button type="button" disabled={hasChecking || (pausedRemainingCount || eligibleCount) === 0}
              onClick={() => void saveItems(null, pausedRemainingCount > 0)}
              className="primary-button rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-50">
              {pausedRemainingCount ? t('继续入库（{count}）', { count: pausedRemainingCount })
                : t('入库已勾选歌曲（{count}）', { count: eligibleCount })}
            </button>}
          </div>
        </div>

        {message && <p role="status" className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm">{t(message)}</p>}
        {pausedRemainingCount > 0 && !saving && <p className="mt-2 text-xs text-[var(--muted)]">{t("已暂停。继续只处理剩余")}{pausedRemainingCount}{t("首；之前失败的歌曲可单独重试。")}</p>}

        {activeUpload && <div className="mt-3 rounded-xl bg-[var(--surface)] px-4 py-3">
          <p className="text-sm font-medium">{t("正在处理：")}{activeUpload.draft.title}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">{t(activeUpload.message, activeUpload.messageValues)}</p>
          {activeProgress && <div className="mt-2">
            <div className="mb-1 flex justify-between text-xs text-[var(--muted)]">
              <span>{activeProgress.kind === 'cover' ? t("封面上传") : t("音频上传")}</span>
              <span>{activePercent}%</span>
            </div>
            <div role="progressbar" aria-label={t("当前媒体上传进度")} aria-valuemin="0" aria-valuemax="100"
              aria-valuenow={activePercent} className="h-2 overflow-hidden rounded-full bg-[var(--line)]">
              <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150"
                style={{ width: activePercent + '%' }} />
            </div>
          </div>}
        </div>}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <input aria-label={t("筛选预览歌曲")} placeholder={t("筛选歌名、歌手、专辑或路径")} value={previewQuery}
            onChange={(event) => { setPreviewQuery(event.target.value); setPreviewPage(1); }}
            className={inputClass + ' min-w-48 flex-1'} />
          <select aria-label={t("筛选入库状态")} value={previewStatus}
            onChange={(event) => { setPreviewStatus(event.target.value); setPreviewPage(1); }}
            className={inputClass + ' w-auto'}>
            <option value="all">{t("全部状态")}</option><option value="selected">{t("已勾选")}</option>
            <option value="pending">{t("待处理")}</option><option value="duplicate">{t("疑似重复")}</option>
            <option value="error">{t("失败")}</option><option value="saved">{t("已入库")}</option>
          </select>
          <select aria-label={t("筛选歌曲语言")} value={previewLanguage}
            onChange={(event) => { setPreviewLanguage(event.target.value); setPreviewPage(1); }}
            className={inputClass + ' w-auto'}>
            <option value="all">{t("全部语言")}</option>
            {ALL_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{t(item.label)}</option>)}
          </select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <span>{t('已勾选 {selected} 首 · 筛选后 {visible} / {total} 首', {
            selected: entries.filter((entry) => entry.selected !== false && entry.status !== 'saved').length,
            visible: previewRows.length, total: entries.length,
          })}</span>
          <button type="button" disabled={saving || !previewRows.length} onClick={() => {
            const keys = new Set(previewRows.map(({ entry }) => entry.key));
            commitEntries((current) => current.map((entry) => entry.status === 'saved' || !keys.has(entry.key)
              ? entry : { ...entry, selected: true }));
          }}>{t("勾选筛选结果")}</button>
          <button type="button" disabled={saving || !previewRows.length} onClick={() => {
            const keys = new Set(previewRows.map(({ entry }) => entry.key));
            commitEntries((current) => current.map((entry) => entry.status === 'saved' || !keys.has(entry.key)
              ? entry : { ...entry, selected: false }));
          }}>{t("取消筛选勾选")}</button>
        </div>

        <div className="mt-4 space-y-2">
          {shownPreviewRows.map(({ entry, index }) => {
            const source = entry.languageEdited ? t("人工修改")
              : entry.languageGuess?.source === 'tag' ? t("标签")
                : entry.languageGuess?.source === 'text' ? t("文字推测")
                  : entry.languageGuess?.source === 'folder' ? t("文件夹") : t("待确认");
            const percent = entry.progress?.total
              ? Math.min(100, Math.round(entry.progress.loaded / entry.progress.total * 100)) : 0;
            return <article key={entry.key}
              className="flex flex-wrap items-start gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3 sm:flex-nowrap sm:p-4">
              <label className="shrink-0 pt-3">
                <input type="checkbox" aria-label={t('选择入库 {title}', { title: entry.draft.title })}
                  checked={entry.selected !== false} disabled={saving || entry.status === 'saved'}
                  onChange={(event) => updateEntry(entry.key, (current) => ({
                    ...current, selected: event.target.checked,
                  }))} />
              </label>
              <CoverThumbnail file={entry.coverFile} previewUrl={entry.coverPreviewUrl} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold" title={entry.draft.title}>
                  {index + 1}. {entry.draft.title}
                </p>
                <p className="mt-1 truncate text-xs text-[var(--muted)]">
                  {entry.draft.artist || t("歌手未设置")} · {entry.draft.album || t("专辑未设置")}
                  {entry.draft.duration ? ' · ' + Math.floor(Number(entry.draft.duration) / 60) + ':' +
                    String(Number(entry.draft.duration) % 60).padStart(2, '0') : ''}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {entry.agent && <span className="text-[var(--muted)]">{t("来自")}{' '}{entry.agent.deviceName} · {entry.agent.path}</span>}
                  <span className="rounded-full border border-[var(--line)] px-2 py-0.5">
                    {getLanguageLabel(entry.draft.language, t("语言未设置"))} · {source}
                  </span>
                  <span className="text-[var(--muted)]">
                    {entry.status === 'saved' && <Check size={12} className="mr-1 inline text-[var(--accent)]" />}
                    {t(statusLabel[entry.status])}{entry.status === 'uploading' && entry.progress ? ' · ' + percent + '%' : ''}
                  </span>
                </div>
                {(entry.status === 'error' || entry.status === 'uploading') &&
                  <p role="status" className="mt-2 text-xs text-[var(--muted)]">{t(entry.message, entry.messageValues)}</p>}
                {entry.agent && entry.coverFile && !entry.coverPreviewUrl && entry.status !== 'saved' &&
                  <button type="button" disabled={loadingCoverId === entry.key || saving}
                    onClick={() => void loadDeviceCover(entry)}
                    className="mt-2 text-xs text-[var(--accent)] disabled:opacity-50">
                    {loadingCoverId === entry.key ? t("正在读取封面…") : t("查看这首的封面")}
                  </button>}
                {entry.duplicateState === 'error' && !entry.allowDuplicate && !saving && <button type="button"
                  className="mt-2 rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs font-semibold"
                  onClick={() => updateEntry(entry.key, (current) => ({
                    ...current, allowDuplicate: true, replaceTarget: null, reviewStale: false, status: 'ready',
                    message: t("查重未完成，已确认忽略并新增歌曲。"),
                  }))}>{t("忽略查重并新增")}</button>}
                {entry.duplicateState === 'error' && entry.allowDuplicate &&
                  <p className="mt-2 text-xs text-[var(--muted)]">{t("查重未完成 · 已人工放行")}</p>}
                {(entry.duplicateMatches?.length > 0 || entry.reviewStale) && <div role="alert"
                  className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                  <p className="font-semibold">{entry.reviewStale ? t("匹配结果已变化，请重新核对") : t("发现 {p0} 项疑似重复", { p0: (entry.duplicateMatches.length) })}
                    {entry.replaceTarget ? t(' · 将替换《{title}》', { title: entry.replaceTarget.title })
                      : entry.allowDuplicate ? t(" · 将新增另一版本") : t(" · 默认跳过")}</p>
                  {entry.duplicateMatches.slice(0, 3).map((match) =>
                    <p key={match.source + (match.id || match.key)} className="mt-1 truncate" title={match.title}>
                      {match.source === 'catalog' ? t("曲库已有") : t("本次清单")}：{match.title}
                      {' · ' + (match.artist || t('歌手未设置'))}
                      {match.duration ? t(' · {seconds} 秒', { seconds: match.duration }) : ''}
                      {match.strength === 'possible' ? t(" · 可能不同版本") : ''}
                    </p>)}
                  {entry.duplicateMatches.length > 3 && <p className="mt-1">{t("另有")}{' '}{entry.duplicateMatches.length - 3}{' '}{t("项匹配")}</p>}
                  {entry.status !== 'saved' && !saving && <button type="button"
                    className="mt-2 rounded-lg border border-amber-500/50 px-2.5 py-1 font-semibold"
                    onClick={() => void openReview(entry.key)}>{t("核对并选择处理方式")}</button>}
                </div>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" disabled={saving || entry.status === 'reading' || entry.status === 'saved'}
                  onClick={() => openEditor(entry.key)}
                  className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{t("编辑")}</button>
                <button type="button" disabled={saving || ['reading', 'checking', 'saved'].includes(entry.status)
                  || entry.reviewStale || (entry.duplicateMatches?.length > 0 && !entry.allowDuplicate)}
                  onClick={() => void saveItems(entry.key)}
                  className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
                  {entry.status === 'error' ? t("重试") : t("入库")}
                </button>
                {!saving && <button type="button" onClick={() => removeEntry(entry.key)}
                  aria-label={t('从清单移除 {title}', { title: entry.draft.title })}
                  className="rounded-lg p-1.5 text-[var(--muted)] hover:text-[var(--ink)]"><X size={15} /></button>}
              </div>
            </article>;
          })}
          {!shownPreviewRows.length && <p className="rounded-xl border border-[var(--line)] px-4 py-8 text-center text-sm text-[var(--muted)]">{t("没有符合筛选条件的歌曲。")}</p>}
        </div>
        {previewRows.length > PREVIEW_PAGE_SIZE && <div className="mt-4 flex items-center justify-end gap-3 text-xs">
          <button type="button" disabled={previewPage === 1} onClick={() => setPreviewPage(previewPage - 1)}>{t("上一页")}</button>
          <span>{previewPage} / {previewPageCount}</span>
          <button type="button" disabled={previewPage >= previewPageCount} onClick={() => setPreviewPage(previewPage + 1)}>{t("下一页")}</button>
        </div>}
      </section>}

      {reviewing && createPortal(<>
        <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-xs" onClick={() => setReviewingId(null)} />
        <section role="dialog" aria-modal="true" aria-label={t('核对重复歌曲：{title}', { title: reviewing.draft.title })}
          className="fixed left-1/2 top-1/2 z-[101] flex max-h-[88dvh] w-[min(94vw,760px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] shadow-2xl">
          <div className="border-b border-[var(--line)] px-5 py-4"><h2 className="font-bold">{t("核对疑似重复")}</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">{t("按当前歌曲逐首选择；替换保留原歌曲 ID 和歌单引用，旧媒体文件保留。")}</p></div>
          <div className="space-y-3 overflow-y-auto p-5 text-sm">
            <div className="rounded-xl border border-[var(--line)] p-3"><strong>{t("本次文件：")}{reviewing.draft.title}</strong>
              <p className="mt-1 text-xs">{reviewing.draft.artist || t("歌手未设置")} · {reviewing.draft.album || t("专辑未设置")} · {reviewing.draft.duration || t("时长未知")}{' '}{t("秒 ·")}{' '}{getLanguageLabel(reviewing.draft.language, t("语言未设置"))}</p>
              <p className="mt-1 break-all text-xs text-[var(--muted)]">{t("文件：")}{reviewing.audioFile.name}{' '}{t("· 音频将使用本次文件")}</p>
              <div className="mt-2 flex items-center gap-2"><CoverThumbnail file={reviewing.coverFile} previewUrl={reviewing.coverPreviewUrl} /><span className="text-xs text-[var(--muted)]">{t("本次封面；无封面时替换会保留旧封面")}</span></div>
              <LocalAudioPreview file={reviewing.audioFile} /></div>
            <label className="flex gap-2 rounded-xl border border-[var(--line)] p-3"><input type="radio" name="duplicate-choice" value="skip"
              checked={reviewChoice === 'skip'} onChange={() => setReviewChoice('skip')} /><span>{t("跳过此首（默认）")}</span></label>
            <label className="flex gap-2 rounded-xl border border-[var(--line)] p-3"><input type="radio" name="duplicate-choice" value="add"
              checked={reviewChoice === 'add'} onChange={() => setReviewChoice('add')} /><span>{t("新增另一版本：创建新的歌曲 ID")}</span></label>
            {!reviewing.duplicateMatches.length && <p className="text-xs text-[var(--muted)]">{t("当前已找不到原匹配项。请明确选择新增，或保持跳过。")}</p>}
            {reviewing.duplicateMatches.map((match) => <div key={match.source + (match.id || match.key)}
              className="rounded-xl border border-[var(--line)] p-3">
              {match.source === 'catalog' && <label className="flex gap-2 font-semibold"><input type="radio" name="duplicate-choice"
                checked={reviewChoice === 'replace:' + match.id} onChange={() => setReviewChoice('replace:' + match.id)} />
                <span>{t("替换这首曲库歌曲")}</span></label>}
              {match.source !== 'catalog' && <strong>{t("本次清单匹配（尚不能替换）")}</strong>}
              <p className="mt-2">{match.title} · {match.artist || t("歌手未设置")} · {match.album || t("专辑未设置")}</p>
              <p className="mt-1 text-xs text-[var(--muted)]">{match.duration || t("时长未知")}{' '}{t("秒 ·")}{' '}{getLanguageLabel(match.language, t("语言未设置"))}
                {' · ' + t(match.strength === 'strong' ? '高度相似' : '可能不同版本')}
                {match.id ? ' · ID ' + match.id : ''}</p>
              {match.source === 'catalog' && <div className="mt-2 flex items-center gap-2">
                {match.cover_url && <PrivateCoverImage src={hydrateSong(match).cover_url} alt={t("现有歌曲封面")} className="h-12 w-12 rounded-lg object-cover" />}
                <span className="text-xs text-[var(--muted)]">{match.cover_url ? t("现有封面") : t("现有歌曲无封面")}</span></div>}
              {match.source === 'catalog' && match.audio_url && <audio controls preload="none" src={hydrateSong(match).audio_url}
                className="mt-2 w-full" aria-label={t('试听曲库歌曲 {title}', { title: match.title })} />}
            </div>)}
          </div>
          <div className="flex justify-end gap-2 border-t border-[var(--line)] p-4"><button type="button" onClick={() => setReviewingId(null)}
            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm">{t("取消")}</button>
            <button type="button" onClick={confirmReview} className="primary-button rounded-lg px-4 py-2 text-sm font-semibold">{t("确认处理方式")}</button></div>
        </section>
      </>, document.body)}

      {editing && createPortal(<>
        <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-xs"
          onClick={() => { if (!saving) closeEditor(); }} />
        <section role="dialog" aria-modal="true" aria-label={t('编辑 {title}', { title: editing.draft.title })}
          className="fixed left-1/2 top-1/2 z-[101] flex max-h-[min(88dvh,760px)] w-[min(92vw,620px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] shadow-2xl">
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-4">
            <div>
              <h2 className="text-base font-bold">{t("编辑歌曲信息")}</h2>
              <p className="mt-0.5 text-xs text-[var(--muted)]">{t("修改会更新预览，点击入库后才上传。")}</p>
            </div>
            <button type="button" onClick={closeEditor} aria-label={t("关闭编辑窗")}
              className="rounded-lg p-2 text-[var(--muted)] hover:text-[var(--ink)]"><X size={18} /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {editorError && <p role="alert" className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm">{t(editorError)}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium sm:col-span-2">{t("歌曲标题")}{' '}<span aria-hidden="true">*</span>
                <input ref={titleInput} className={inputClass + ' mt-1.5'} value={editing.draft.title}
                  onChange={(event) => setField('title', event.target.value)} /></label>
              <label className="text-sm font-medium">{t("歌手")}<input className={inputClass + ' mt-1.5'} value={editing.draft.artist}
                  onChange={(event) => setField('artist', event.target.value)} /></label>
              <label className="text-sm font-medium">{t("专辑")}<input className={inputClass + ' mt-1.5'} value={editing.draft.album}
                  onChange={(event) => setField('album', event.target.value)} /></label>
              <label className="text-sm font-medium">{t("时长（秒）")}<input className={inputClass + ' mt-1.5'} type="number" min="0" max="86400" step="1"
                  value={editing.draft.duration}
                  onChange={(event) => setField('duration', event.target.value)} /></label>
              <label className="text-sm font-medium">{t("歌曲语言")}<select className={inputClass + ' mt-1.5'} value={editing.draft.language}
                  onChange={(event) => setField('language', event.target.value)}>
                  <option value="">{t("未设置")}</option>
                  {ALL_LANGUAGES.map(({ code, label }) => <option key={code} value={code}>{t(label)}</option>)}
                </select>
                <span className="mt-1 block text-xs text-[var(--muted)]">
                  {editing.languageEdited ? t("已人工修改")
                    : t(editing.languageGuess?.reason || '未能从音频标签判断语言')}
                </span>
              </label>
            </div>
            <div className="border-t border-[var(--line)] pt-5">
              <h3 className="mb-3 text-sm font-bold">{t("封面")}</h3>
              <div className="flex items-start gap-4">
                <CoverThumbnail file={editing.coverFile} />
                <div className="min-w-0 space-y-2">
                  <p className="text-xs text-[var(--muted)]">{t("优先读取内嵌封面，也可替换。")}</p>
                  <label className="inline-flex cursor-pointer rounded-lg border border-[var(--line)] px-3 py-2 text-xs font-semibold">{t("选择封面图片")}<input type="file" accept=".jpg,.jpeg,.png,.webp" className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) setCover(file);
                        event.target.value = '';
                      }} />
                  </label>
                  {editing.coverFile && <button type="button" onClick={() => setCover(null)}
                    className="block text-xs text-[var(--muted)] hover:text-[var(--ink)]">{t("移除封面")}</button>}
                </div>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 justify-end border-t border-[var(--line)] bg-[var(--surface-raised)] px-5 py-4">
            <button type="button" onClick={closeEditor}
              className="primary-button rounded-xl px-5 py-2.5 text-sm font-semibold">{t("完成编辑")}</button>
          </div>
        </section>
      </>, document.body)}
    </div>
  );
}
