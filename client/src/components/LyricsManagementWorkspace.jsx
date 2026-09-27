import React from 'react';
import { Check, ChevronDown, ChevronUp, Download, FileUp, Languages, Loader2,
  Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useUIStore, showToast } from '../store/useUIStore.js';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { useManagedLyricsAsset } from '../hooks/useManagedLyricsAsset.js';
import { useCompactPlayerPlacement } from '../hooks/useCompactPlayerPlacement.js';
import { lyricsWorkspaceApi } from '../services/localLyricsWorkspaceApi.js';
import { findActiveLyricLineIndex } from '../utils/lyricTimeline.js';
import { sortLyricsCandidates, projectProviderWarnings } from './LyricsManagementWorkspace.state.js';
import { formatPath, returnToOriginRoute, syncBrowserHistory } from '../utils/navigation.js';
import SyncedLyricText from './lyrics/SyncedLyricText.jsx';
import ProgressBar from './playerbar/ProgressBar.jsx';
import PageBackButton from './PageBackButton.jsx';
import { insertLyricRow, parseLyricTime, serializeLyricEditorRows, validateLyricRows } from './LyricsManagementWorkspace.editor.js';
import { centeredLyricScrollTop } from './lyricPreviewScroll.js';
import { projectTimelineShift, stepTimelineShift, timelineShiftAtY } from './lyricTimelineShift.js';
import './lyrics-management-workspace.css';

const SOURCES = { kugou: '酷狗', netease: '网易云', lrclib: 'LRCLIB', manual: '手动整理' };
const MODES = { word: '逐字', line: '逐行', none: '无时间轴' };
const playbackTime = (seconds) => {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
};
const keyOf = (value) => String(value?.source || '') + ':' + String(value?.providerLyricId || '');
const stamp = (seconds) => {
  if (!Number.isFinite(seconds)) return '';
  const ms = Math.round(seconds * 1000);
  return String(Math.floor(ms / 60000)).padStart(2, '0') + ':'
    + String(Math.floor((ms % 60000) / 1000)).padStart(2, '0') + '.'
    + String(ms % 1000).padStart(3, '0');
};
const linesOf = (value) => {
  const doc = value?.lyrics || value?.document || value?.preview || value;
  const original = doc?.original || doc;
  const lines = original?.lines || [];
  const translations = doc?.translation?.lines || value?.translation?.lines || [];
  return Array.isArray(lines) ? lines.map((line, index) => ({
    ...line, tlyric: line.tlyric || translations[index] || '',
  })) : [];
};
const makeRows = (lyrics) => linesOf(lyrics).map((line, index) => ({
  key: String(index), time: stamp(line.time), originalTime: stamp(line.time), originalTimeValue: line.time,
  text: line.text, originalText: line.text, translation: line.tlyric || '',
  words: line.words, endTime: line.endTime,
}));
function download(name, data, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Preview({ value, currentTime, followsPlayback, editing = false, rows = [], errors = {}, previewShiftMs = 0,
  activeCell, onActivate, onPatch, onInsert, onDelete, changedWordRows = 0 }) {
  const lines = React.useMemo(() => projectTimelineShift(linesOf(value), previewShiftMs), [value, previewShiftMs]);
  const mode = value?.syncMode || value?.lyrics?.syncMode || value?.document?.syncMode || 'none';
  const active = followsPlayback && !editing ? findActiveLyricLineIndex(lines, currentTime, mode) : -1;
  const previewRef = React.useRef(null);
  const activeRef = React.useRef(null);
  const hasShownFirstLine = React.useRef(false);
  React.useLayoutEffect(() => {
    if (active < 0 || editing) return;
    const container = previewRef.current;
    const line = activeRef.current;
    if (!container || !line) return;
    const containerRect = container.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    const target = centeredLyricScrollTop({
      scrollTop: container.scrollTop,
      containerTop: containerRect.top,
      containerHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      lineTop: lineRect.top,
      lineHeight: lineRect.height,
    });
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    container.scrollTo({ top: target, behavior: hasShownFirstLine.current && !reducedMotion ? 'smooth' : 'auto' });
    hasShownFirstLine.current = true;
  }, [active, editing]);
  if (!editing && !lines.length) return <div className="lyric-studio__empty">没有可预览的歌词正文。</div>;
  const addAfter = (key) => {
    const nextKey = 'new-' + crypto.randomUUID();
    onInsert(key, nextKey);
    onActivate({ key: nextKey, field: 'text' });
  };
  const handleLineBreak = (event, key) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    addAfter(key);
  };
  const closeCell = (key, field) => onActivate((current) =>
    current?.key === key && current.field === field ? null : current);
  return <div ref={previewRef} className={'lyric-studio__preview' + (followsPlayback && !editing ? ' is-following' : '')}
    aria-label="歌词全文预览">
    {editing && <p className="lyric-studio__edit-hint">点击歌词、译文或时间直接修改；在歌词中按 Enter 插入下一行。</p>}
    {editing && changedWordRows > 0 && <p className="lyric-studio__warning">已修改 {changedWordRows} 行逐字内容，保存后这些行会改为逐行同步。</p>}
    {editing ? rows.map((row, index) => <div key={row.key}
      className={'lyric-studio__line lyric-studio__line--editable' + (errors[row.key] ? ' has-error' : '')}>
      <div className="lyric-studio__time-cell">
        {activeCell?.key === row.key && activeCell.field === 'time' ?
          <input autoFocus aria-label={'第' + (index + 1) + '行时间'} value={row.time} placeholder="00:00.000"
            onChange={(event) => onPatch(row.key, { time: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onActivate({ key: row.key, field: 'text' }); } }}
            onBlur={() => closeCell(row.key, 'time')} /> :
          <button type="button" className="lyric-studio__edit-trigger lyric-studio__edit-trigger--time"
            onClick={() => onActivate({ key: row.key, field: 'time' })} aria-label={'编辑第' + (index + 1) + '行时间'}>
            <time>{row.time && previewShiftMs
              ? stamp(Math.max(0, (parseLyricTime(row.time) ?? 0) + previewShiftMs / 1000))
              : row.time || '设置时间'}</time></button>}
        {errors[row.key]?.time && <small className="lyric-studio__field-error" role="alert">{errors[row.key].time}</small>}
      </div>
      <div className="lyric-studio__text-cell">
        {activeCell?.key === row.key && activeCell.field === 'text' ?
          <textarea autoFocus rows={1} aria-label={'第' + (index + 1) + '行歌词'} value={row.text}
            onChange={(event) => onPatch(row.key, { text: event.target.value })}
            onKeyDown={(event) => handleLineBreak(event, row.key)} onBlur={() => closeCell(row.key, 'text')} /> :
          <button type="button" className="lyric-studio__edit-trigger lyric-studio__edit-trigger--text"
            onClick={() => onActivate({ key: row.key, field: 'text' })} aria-label={'编辑第' + (index + 1) + '行歌词'}>
            {row.text || '点击填写歌词'}</button>}
        {errors[row.key]?.text && <small className="lyric-studio__field-error" role="alert">{errors[row.key].text}</small>}
        {activeCell?.key === row.key && activeCell.field === 'translation' ?
          <input autoFocus aria-label={'第' + (index + 1) + '行译文'} value={row.translation}
            onChange={(event) => onPatch(row.key, { translation: event.target.value })}
            onKeyDown={(event) => handleLineBreak(event, row.key)} onBlur={() => closeCell(row.key, 'translation')} /> :
          <button type="button" className="lyric-studio__edit-trigger lyric-studio__edit-trigger--translation"
            onClick={() => onActivate({ key: row.key, field: 'translation' })} aria-label={'编辑第' + (index + 1) + '行译文'}>
            {row.translation || '+ 译文'}</button>}
      </div>
      <button type="button" className="lyric-studio__delete-line" aria-label={'删除第' + (index + 1) + '行'}
        onClick={() => onDelete(row.key)}><Trash2 size={16} /></button>
    </div>) : lines.map((line, index) => <div key={index} ref={index === active ? activeRef : null}
      className={'lyric-studio__line' + (index === active ? ' is-active' : '')}>
      <time>{stamp(line.time) || '—'}</time>
      <div><p><SyncedLyricText line={line} text={line.text} active={index === active}
        visible syncMode={mode} surface="workspace" /></p>
        {line.tlyric && <small>{line.tlyric}</small>}</div>
    </div>)}
    {editing && <button type="button" className="lyric-studio__add-line" onClick={() => addAfter(rows.at(-1)?.key)}>
      <Plus size={16} />新增一行</button>}
  </div>;
}
function TimelineShiftRail({ value, onChange, onApply, saving, draft = false }) {
  const railRef = React.useRef(null);
  const trackRef = React.useRef(null);
  React.useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    const onWheel = (event) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      onChange((current) => stepTimelineShift(current, event.deltaY > 0 ? 1 : -1));
    };
    rail.addEventListener('wheel', onWheel, { passive: false });
    return () => rail.removeEventListener('wheel', onWheel);
  }, [onChange]);
  const updateFromPointer = (event) => {
    const bounds = trackRef.current?.getBoundingClientRect();
    if (bounds) onChange(timelineShiftAtY(event.clientY, bounds.top, bounds.height));
  };
  const description = value < 0 ? `提前 ${(Math.abs(value) / 1000).toFixed(2)} 秒`
    : value > 0 ? `延后 ${(value / 1000).toFixed(2)} 秒` : '未位移';
  return <div ref={railRef} className="lyric-studio__shift-rail" aria-label="整体调整歌词时间轴">
    <span className="lyric-studio__shift-label">时间轴位移</span>
    <button type="button" aria-label="歌词整体提前50毫秒" onClick={() => onChange((current) => stepTimelineShift(current, -1))}><ChevronUp size={18} /></button>
    <div ref={trackRef} className="lyric-studio__shift-track" role="slider" tabIndex={0}
      aria-label="整体位移" aria-valuemin={-5000} aria-valuemax={5000} aria-valuenow={value} aria-valuetext={description}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); updateFromPointer(event); }}
      onPointerMove={(event) => { if (event.buttons) updateFromPointer(event); }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') onChange((current) => stepTimelineShift(current, -1));
        else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') onChange((current) => stepTimelineShift(current, 1));
        else if (event.key === 'Home') onChange(-5000);
        else if (event.key === 'End') onChange(5000);
        else return;
        event.preventDefault();
      }}>
      <span className="lyric-studio__shift-track-line" />
      <span className="lyric-studio__shift-thumb" style={{ top: `${(value + 5000) / 100}%` }} />
    </div>
    <button type="button" aria-label="歌词整体延后50毫秒" onClick={() => onChange((current) => stepTimelineShift(current, 1))}><ChevronDown size={18} /></button>
    <output className="lyric-studio__shift-value" aria-live="polite">{value === 0 ? '0.00s' : `${value > 0 ? '+' : '−'}${(Math.abs(value) / 1000).toFixed(2)}s`}</output>
    {draft ? <small>保存时生效</small> : <button type="button" className="lyric-studio__shift-apply" disabled={saving || value === 0} onClick={onApply}>应用</button>}
    <button type="button" className="lyric-studio__shift-clear" disabled={saving || value === 0} onClick={() => onChange(0)}>清零</button>
  </div>;
}
export default function LyricsManagementWorkspace({ route, songFromLibrary, onNavigate }) {
  const selectedSong = useUIStore((state) => state.lyricsWorkspaceSong);
  const baseSong = String(selectedSong?.id) === String(route?.songId) ? selectedSong
    : songFromLibrary || (route?.songId ? { id: route.songId, title: '当前歌曲' } : null);
  const auth = useUIStore((state) => state.authSession);
  const authenticated = Boolean(auth?.authenticated);
  const isAdmin = authenticated && auth?.user?.role === 'admin';
  const playingSong = usePlayerStore((state) => state.currentSong);
  const { placement: compactPlayerPlacement } = useCompactPlayerPlacement('lyrics');
  const currentTime = usePlayerStore((state) => state.currentTime ?? state.progress ?? 0);
  const duration = usePlayerStore((state) => state.duration);
  const managed = useManagedLyricsAsset({ songId: baseSong?.id, enabled: Boolean(baseSong?.id) && authenticated });
  const song = managed.song ? { ...baseSong, ...managed.song } : baseSong;
  const section = route?.section || 'current';
  const setSection = (next) => syncBrowserHistory(formatPath({ type: 'page', page: 'lyrics', songId: song.id, section: next }), { replace: true });
  const [editing, setEditing] = React.useState(false);
  const [activeCell, setActiveCell] = React.useState(null);
  const [rows, setRows] = React.useState([]);
  const [shift, setShift] = React.useState(0);
  const [searchTitle, setSearchTitle] = React.useState(song?.title || '');
  const [searchArtist, setSearchArtist] = React.useState(song?.artist || '');
  const [candidates, setCandidates] = React.useState([]);
  const [inspections, setInspections] = React.useState({});
  const [selected, setSelected] = React.useState(null);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState('');
  const [warnings, setWarnings] = React.useState([]);
  const [draftAiBusy, setDraftAiBusy] = React.useState(false);
  const draftRequestRef = React.useRef(0);
  const draftEditVersionRef = React.useRef(0);
  const draftReceiptRef = React.useRef(null);
  const fileRef = React.useRef(null);
  const backupRef = React.useRef(null);
  const initialRowsRef = React.useRef([]);
  const editingEtagRef = React.useRef(null);
  const closeGuardRef = React.useRef(() => true);
  const generation = React.useRef(0);
  const hasAsset = managed.asset?.status === 'ready';
  const hasTimeline = hasAsset && ['line', 'word'].includes(managed.asset?.original?.syncMode);
  const draftMode = rows.some((row) => row.words?.length) ? 'word'
    : rows.some((row) => row.time) ? 'line' : 'none';
  const followsPlayback = String(playingSong?.id) === String(song?.id);
  const sorted = React.useMemo(() => sortLyricsCandidates(candidates, inspections), [candidates, inspections]);
  const selectedIndex = sorted.findIndex((candidate) => keyOf(candidate) === keyOf(selected));
  const inspection = selected ? inspections[keyOf(selected)] : null;
  const changedWordRows = rows.filter((row) => row.words?.length
    && (row.time !== row.originalTime || row.text !== row.originalText)).length;
  const rowErrors = React.useMemo(() => validateLyricRows(rows), [rows]);
  const canDiscardEdits = () => {
    const hasRowChanges = editing && JSON.stringify(rows) !== JSON.stringify(initialRowsRef.current);
    return (!hasRowChanges && shift === 0) || window.confirm('歌词有未保存的修改或位移草稿，确定放弃吗？');
  };
  closeGuardRef.current = canDiscardEdits;
  const discardEdits = () => {
    if (!canDiscardEdits()) return false;
    draftRequestRef.current += 1;
    draftReceiptRef.current = null;
    setDraftAiBusy(false);
    setEditing(false);
    setActiveCell(null);
    setShift(0);
    return true;
  };
  const leaveWorkspace = () => {
    if (!useUIStore.getState().approveLyricsWorkspaceExit()) return;
    if (returnToOriginRoute('/home') === 'replace') onNavigate?.('home');
  };

  React.useEffect(() => {
    setEditing(false); setActiveCell(null); setShift(0); setCandidates([]); setInspections({});
    draftRequestRef.current += 1; setDraftAiBusy(false);
    draftReceiptRef.current = null;
    setSelected(null); setSearchTitle(song?.title || ''); setSearchArtist(song?.artist || '');
    generation.current += 1;
  }, [song?.id]);
  React.useEffect(() => {
    if (!selected || !song?.id) return undefined;
    const sourceIndex = candidates.findIndex((candidate) => keyOf(candidate) === keyOf(selected));
    if (sourceIndex < 0) return undefined;
    const nearby = candidates.slice(sourceIndex, sourceIndex + 4);
    const keys = new Set(nearby.map(keyOf));
    const missing = nearby.filter((item) => !inspections[keyOf(item)]);
    if (!missing.length) return undefined;
    let cancelled = false;
    const options = { title: searchTitle.trim(), artist: searchArtist.trim() };
    void lyricsWorkspaceApi.inspectLyricsCandidates(song.id,
      missing.map((item) => ({ source: item.source, providerLyricId: item.providerLyricId })), options)
      .then((response) => {
        if (cancelled) return;
        setInspections((current) => ({ ...current,
          ...Object.fromEntries((response.data?.results || []).filter((item) => keys.has(keyOf(item)))
            .map((item) => [keyOf(item), item])) }));
      }).catch(() => {
        if (cancelled) return;
        setInspections((current) => ({ ...current,
          ...Object.fromEntries(missing.map((item) => [keyOf(item), { state: 'error' }])) }));
      });
    return () => { cancelled = true; };
  }, [selected, candidates, song?.id, searchTitle, searchArtist]);
  React.useEffect(() => {
    if (baseSong?.title !== '当前歌曲' || !managed.song) return;
    setSearchTitle(managed.song.title || '');
    setSearchArtist(managed.song.artist || '');
  }, [baseSong?.title, managed.song?.title, managed.song?.artist]);
  React.useEffect(() => {
    useUIStore.getState().setLyricsWorkspaceBeforeCloseGuard(() => closeGuardRef.current());
    return () => useUIStore.getState().setLyricsWorkspaceBeforeCloseGuard(null);
  }, []);
  React.useEffect(() => {
    if ((!editing || JSON.stringify(rows) === JSON.stringify(initialRowsRef.current)) && shift === 0) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [editing, rows, shift]);
  if (!song) return <div className="lyric-studio"><p>请选择歌曲后打开歌词工作台。</p></div>;

  const patchRow = (key, patch) => {
    draftEditVersionRef.current += 1;
    if (patch.text !== undefined) draftReceiptRef.current = null;
    setRows((all) => all.map((row) => row.key === key ? { ...row, ...patch } : row));
  };
  const insertRow = (afterKey, newKey) => {
    draftEditVersionRef.current += 1;
    draftReceiptRef.current = null;
    setRows((all) => insertLyricRow(all, afterKey, newKey));
  };
  const deleteRow = (key) => {
    draftEditVersionRef.current += 1;
    draftReceiptRef.current = null;
    setRows((all) => all.filter((row) => row.key !== key));
  };
  const changeShift = (value) => {
    draftEditVersionRef.current += 1;
    setShift(value);
  };
  const collectDraftLines = () => {
    if (!rows.length) return showToast('至少保留一行歌词');
    const errors = validateLyricRows(rows);
    const firstInvalid = rows.find((row) => errors[row.key]);
    if (firstInvalid) {
      setActiveCell({ key: firstInvalid.key, field: errors[firstInvalid.key].time ? 'time' : 'text' });
      showToast('请先修正标红的歌词或时间');
      return null;
    }
    return serializeLyricEditorRows(rows, shift);
  };
  const saveRows = async () => {
    const lines = collectDraftLines();
    if (!lines) return;
    if (changedWordRows && !window.confirm('有 ' + changedWordRows + ' 行修改了逐字内容，保存后这些行会改为逐行同步。继续吗？')) return;
    const result = await managed.saveDocument(lines, editingEtagRef.current, draftReceiptRef.current);
    if (result === true) { setEditing(false); setActiveCell(null); setShift(0); }
    else if (result === 'conflict') {
      setEditing(false); setActiveCell(null);
      setRows([]);
      showToast('歌词已由其他人更新，请基于最新版本重新打开编辑。');
    }
  };
  const completeDraftWithLines = async (lines) => {
    if (draftAiBusy) return;
    if (!lines) return;
    const requestId = ++draftRequestRef.current;
    const editVersion = draftEditVersionRef.current;
    setDraftAiBusy(true);
    try {
      const response = await lyricsWorkspaceApi.completeDraftLyrics(song.id,
        { lines, etag: editingEtagRef.current });
      if (draftRequestRef.current !== requestId) return;
      if (draftEditVersionRef.current !== editVersion) {
        showToast('AI 处理期间草稿已修改，保留当前修改；需要时可重新补全');
        return;
      }
      const completed = response.data;
      draftReceiptRef.current = completed.receipt || null;
      setRows(makeRows({ lines: completed.lines }));
      setShift(0);
      setActiveCell(null);
      showToast('AI 已补全并清理草稿，检查后保存一次即可共享');
    } catch (error) {
      if (draftRequestRef.current === requestId) showToast(error?.message || '草稿 AI 补全失败');
    } finally {
      if (draftRequestRef.current === requestId) setDraftAiBusy(false);
    }
  };
  const completeDraft = () => completeDraftWithLines(collectDraftLines());
  const search = async () => {
    if (!authenticated || !song?.id || searching) return;
    const current = ++generation.current;
    const options = { title: searchTitle.trim(), artist: searchArtist.trim() };
    setSearching(true); setSearchError(''); setWarnings([]); setCandidates([]); setInspections({}); setSelected(null);
    try {
      const response = await lyricsWorkspaceApi.getLyricsCandidates(song.id, options);
      if (current !== generation.current) return;
      const found = (response.data?.candidates || []).slice(0, 12);
      setCandidates(found);
      setWarnings(projectProviderWarnings(response.data?.warnings));
      if (found.length) setSelected(found[0]);
    } catch (error) {
      if (current === generation.current) setSearchError(error?.message || '查找歌词失败');
    } finally {
      if (current === generation.current) setSearching(false);
    }
  };
  const exportFile = (kind) => {
    if (!hasAsset) return;
    const name = String(song.title || song.id).replace(/[\\/:*?"<>|]/g, '_');
    if (kind === 'backup') download(name + '.lyrics.json',
      JSON.stringify(managed.asset, null, 2), 'application/json;charset=utf-8');
    else {
      const text = kind === 'translation' ? managed.lyrics?.tlyric : managed.lyrics?.lrc;
      if (!text) return showToast('没有可导出的内容');
      download(name + (kind === 'translation' ? '.translation.lrc' : '.lrc'), text);
    }
  };
  const importFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!canDiscardEdits()) return;
    if (file.size > 1_900_000) return showToast('LRC 文件不能超过 1.9 MB');
    if (hasAsset && !window.confirm('导入会替换当前共享歌词。继续吗？')) return;
    if (await managed.importLrc(await file.text())) { setEditing(false); setShift(0); setSection('current'); }
  };
  const restoreFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!canDiscardEdits()) return;
    if (file.size > 3_900_000) return showToast('备份文件不能超过 3.9 MB');
    let asset;
    try { asset = JSON.parse(await file.text()); }
    catch { return showToast('备份不是有效的 JSON 文件'); }
    if (!window.confirm('恢复备份会替换这首歌当前使用的共享歌词。继续吗？')) return;
    if (await managed.restoreBackup(asset)) { setEditing(false); setShift(0); setSection('current'); }
  };
  return <div className="lyric-studio app-page" data-section={section} data-player-placement={compactPlayerPlacement}
    aria-labelledby={section === 'candidates' ? undefined : 'lyric-studio-title'}
    aria-label={section === 'candidates' ? '候选歌词' : undefined}>
    <header className="lyric-studio__header">
      {section !== 'candidates' && <div className="lyric-studio__heading"><span>歌词工作台</span><h2 id="lyric-studio-title">{song.title}</h2>
        <div className="lyric-studio__heading-meta"><p>{song.artist || '未知歌手'}</p>
          {section === 'current' && <div className="lyric-studio__formats" aria-label="当前歌词来源与同步方式">
            <span>{editing ? '未保存草稿' : SOURCES[managed.asset?.original?.source] || '未建立'}</span>
            <span>{MODES[editing ? draftMode : managed.asset?.original?.syncMode] || '无时间轴'}</span>
          </div>}
        </div>
      </div>}
      {section === 'current' && <div className="lyric-studio__actions">
        <button type="button" onClick={() => void managed.load()}><RefreshCw size={15} />刷新</button>
        {authenticated && managed.aiCompletionEnabled && (!editing || isAdmin) && <button type="button"
          disabled={editing ? draftAiBusy || managed.saving
            : !hasAsset || managed.saving || managed.isAiCompleting}
          onClick={() => void (editing ? completeDraft() : managed.completeTranslation())}>
          {draftAiBusy || managed.isAiCompleting ? 'AI 补全中…' : 'AI 补全'}</button>}
        {isAdmin && hasAsset && !editing && <button type="button" disabled={shift !== 0} title={shift ? '请先应用或清零时间轴位移' : undefined} onClick={() => {
          const nextRows = makeRows(managed.lyrics);
          initialRowsRef.current = nextRows;
          editingEtagRef.current = managed.etag;
          draftReceiptRef.current = null;
          setRows(nextRows);
          setActiveCell(null);
          setEditing(true);
        }}>编辑歌词</button>}
        {editing && <><button type="button" disabled={draftAiBusy} onClick={discardEdits}>取消</button>
          <button type="button" className="is-primary" disabled={managed.saving || draftAiBusy} onClick={() => void saveRows()}><Check size={15} />保存</button></>}
      </div>}
      <PageBackButton className="lyric-studio__back" onClick={leaveWorkspace} />
    </header>
    {playingSong?.id && !followsPlayback && <div className="lyric-studio__notice">播放器已切换；仍在查看《{song.title}》。
      <button type="button" onClick={() => {
        if (discardEdits()) useUIStore.getState().openLyricsWorkspace(playingSong);
      }}>切到当前歌曲</button></div>}
    <div className="lyric-studio__layout">
      {section === 'current' && <section className="lyric-studio__main" aria-label="当前歌词">
        {managed.loading && <div className="lyric-studio__empty"><Loader2 className="animate-spin" />正在读取歌词…</div>}
        {!managed.loading && !hasAsset && !editing && <div className="lyric-studio__empty"><Languages size={28} />
          <strong>这首歌还没有歌词</strong><p>可查找候选，或由管理员导入 LRC。</p>
          <button type="button" onClick={() => setSection('candidates')}>查找歌词</button></div>}
        {!managed.loading && (hasAsset || editing) && <div className={'lyric-studio__preview-frame' + (isAdmin && (hasTimeline || editing && rows.some((row) => row.time)) ? ' has-shift-rail' : '')}>
          <Preview key={song.id} value={managed.lyrics} previewShiftMs={shift}
          currentTime={currentTime} followsPlayback={followsPlayback} editing={editing} rows={rows}
          errors={rowErrors} activeCell={activeCell} onActivate={setActiveCell}
          onPatch={patchRow} onInsert={insertRow} onDelete={deleteRow} changedWordRows={changedWordRows} />
          {isAdmin && (hasTimeline || editing && rows.some((row) => row.time)) && <TimelineShiftRail
            value={shift} onChange={editing ? changeShift : setShift} saving={managed.saving} draft={editing} onApply={async () => {
              if (await managed.shiftTimeline(shift)) setShift(0);
            }} />}</div>}
        {managed.error && <p className="lyric-studio__error" role="alert">{managed.error}</p>}
        {followsPlayback && <div className="lyric-studio__timeline" aria-label="当前歌曲播放进度">
          <time>{playbackTime(currentTime)}</time>
          <ProgressBar />
          <time>{playbackTime(duration)}</time>
        </div>}
      </section>}
      <div className="lyric-studio__candidates">
        {section === 'tools' && <div className="lyric-studio__management">
          <section className="lyric-studio__card"><div><strong>文件</strong>
            <p>LRC 可用于其他播放器；JSON 备份保留逐字时间。</p></div>
            <div className="lyric-studio__file-actions">
              {isAdmin && <><input ref={fileRef} type="file" accept=".lrc,.txt,text/plain"
                className="lyric-studio__file-input" aria-label="导入 LRC 文件" onChange={(event) => void importFile(event)} />
                <button type="button" onClick={() => fileRef.current?.click()}><FileUp size={16} />导入 LRC</button></>}
              {isAdmin && <><input ref={backupRef} type="file" accept=".json,application/json"
                className="lyric-studio__file-input" aria-label="导入歌词备份" onChange={(event) => void restoreFile(event)} />
                <button type="button" onClick={() => backupRef.current?.click()}><FileUp size={16} />导入备份</button></>}
              <button type="button" disabled={!hasAsset} onClick={() => exportFile('original')}><Download size={16} />导出 LRC</button>
              <button type="button" disabled={!managed.asset?.translation} onClick={() => exportFile('translation')}><Download size={16} />导出译文</button>
              <button type="button" disabled={!hasAsset} onClick={() => exportFile('backup')}><Download size={16} />完整备份</button>
            </div></section>
          {isAdmin && <section className="lyric-studio__card"><div><strong>歌词管理</strong>
            <p>译文清理与歌词重置。</p></div>
            <div className="lyric-studio__file-actions">
              <button type="button" disabled={!managed.asset?.translation || managed.saving}
                onClick={() => void managed.clearTranslation()}><Trash2 size={16} />清除译文</button>
              <button type="button" disabled={managed.saving} onClick={async () => {
                if (!canDiscardEdits()) return;
                if (window.confirm('确定重置这首歌的共享歌词？') && await managed.reset()) setShift(0);
              }}><Trash2 size={16} />重置歌词</button>
            </div></section>}
        </div>}
        {section === 'candidates' && <div className="lyric-studio__candidate-content">
        <div className="lyric-studio__toolbar"><div className="lyric-studio__section-title"><Search size={18} /><strong>候选歌词</strong></div></div>
        <form className="lyric-studio__search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <label>歌名<input value={searchTitle} onChange={(event) => setSearchTitle(event.target.value)} /></label>
          <label>歌手<input value={searchArtist} onChange={(event) => setSearchArtist(event.target.value)} /></label>
          <button type="submit" disabled={searching || !searchTitle.trim()}>
            {searching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}查找候选</button>
        </form>
        {warnings.length > 0 && <p className="lyric-studio__warning">{warnings.map((item) => item.text).join('；')}</p>}
        {searchError && <p className="lyric-studio__error" role="alert">{searchError}</p>}
        <div className="lyric-studio__candidate-list" aria-label="切换候选歌词">
          {sorted.map((candidate) => {
            const result = inspections[keyOf(candidate)];
            return <button type="button" key={keyOf(candidate)}
              className={'lyric-studio__candidate' + (selected && keyOf(candidate) === keyOf(selected) ? ' is-selected' : '')}
              onClick={() => setSelected(candidate)}>
              <strong>{candidate.matchedTitle || song.title}</strong>
              <small>{candidate.matchedArtist || song.artist || '未知歌手'} · {SOURCES[candidate.source] || candidate.source}</small>
              <span>{result?.state === 'ready'
                ? `${MODES[result.syncMode] || '无时间轴'} · ${result.translationAvailable ? '有翻译' : '无翻译'}`
                : result?.state === 'error' ? '检测失败' : '选中后检测'}</span>
            </button>;
          })}
          {!searching && !sorted.length && <p className="lyric-studio__empty is-small">输入歌名后查找可用歌词。</p>}
        </div>
        {selected && <div className="lyric-studio__candidate-preview">
          <div className="lyric-studio__candidate-preview-heading"><div className="lyric-studio__candidate-navigation"><button type="button" disabled={selectedIndex <= 0} onClick={() => setSelected(sorted[selectedIndex - 1])} aria-label="上一份候选">‹</button><strong>{selectedIndex + 1} / {sorted.length} · {SOURCES[selected.source] || selected.source} · {MODES[inspection?.syncMode] || '读取中'}</strong><button type="button" disabled={selectedIndex >= sorted.length - 1} onClick={() => setSelected(sorted[selectedIndex + 1])} aria-label="下一份候选">›</button></div>
            {isAdmin && <button type="button" className="is-primary" disabled={inspection?.state !== 'ready' || managed.saving}
              onClick={() => {
                if (!canDiscardEdits()) return;
                const nextRows = makeRows(inspection);
                if (!nextRows.length) return showToast('这份候选没有可导入的歌词');
                draftRequestRef.current += 1;
                draftEditVersionRef.current += 1;
                setDraftAiBusy(false);
                initialRowsRef.current = makeRows(managed.lyrics);
                editingEtagRef.current = managed.etag;
                draftReceiptRef.current = null;
                setRows(nextRows);
                setActiveCell(null);
                setShift(0);
                setEditing(true);
                setSection('current');
                showToast('已导入当前歌词草稿，编辑并保存后才会共享');
              }}>导入当前歌词草稿</button>}
          </div>
          {inspection?.state === 'ready'
            ? <Preview key={keyOf(selected)} value={inspection} currentTime={currentTime} followsPlayback={followsPlayback} />
            : <p className="lyric-studio__empty is-small">{!inspection ? '正在读取候选歌词…'
              : inspection?.state === 'error' ? '候选预览失败。' : '这份候选没有可预览的歌词。'}</p>}
        </div>}
        </div>}
      </div>
    </div>
  </div>;
}
