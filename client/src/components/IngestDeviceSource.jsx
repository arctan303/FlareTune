import SelectControl from './SelectControl.jsx';
import { getLocale, t } from '../i18n/index.js';
import React from 'react';
import { Disc } from 'lucide-react';
import { ALL_LANGUAGES, getLanguageLabel } from '../constants/language.js';
import { deviceFolder, resolveDeviceLanguage } from '../utils/deviceFolderLanguage.js';
import { listCatalogSongs } from '../services/catalogAdminApi.js';
import { classifyDeviceFiles, DEVICE_INGEST_STATES, loadIngestCatalog } from '../utils/deviceIngestClassification.js';
import { getDeviceManifest as readManifest, listIngestDevices as listDevices,
  runDeviceJob as deviceJob } from '../services/ingestDeviceApi.js';

const PAGE_SIZE = 25;
const formatDuration = (seconds) => seconds
  ? `${Math.floor(Number(seconds) / 60)}:${String(Math.round(Number(seconds)) % 60).padStart(2, '0')}` : t('时长未知');

export default function IngestDeviceSource({ disabled, onAdd, sessionGuardRef, queueEntries = [] }) {
  const listIngestDevices = () => sessionGuardRef.current.run((signal) => listDevices(signal));
  const runDeviceJob = (id, value) => sessionGuardRef.current.run((signal) => deviceJob(id, value, { signal }));
  const [devices, setDevices] = React.useState([]);
  const [deviceId, setDeviceId] = React.useState('');
  const [files, setFiles] = React.useState([]);
  const [catalog, setCatalog] = React.useState(null);
  const [statusFilter, setStatusFilter] = React.useState('new');
  const [checkError, setCheckError] = React.useState('');
  const requestVersion = React.useRef(0);
  const [selected, setSelected] = React.useState(new Set());
  const [mappings, setMappings] = React.useState({});
  const [query, setQuery] = React.useState('');
  const [folderFilter, setFolderFilter] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const current = devices.find((device) => device.id === deviceId);
  const savedCount = queueEntries.filter((entry) => entry.status === 'saved').length;
  const rows = React.useMemo(() => catalog ? classifyDeviceFiles(files, catalog, queueEntries, deviceId) : [],
    [files, catalog, queueEntries, deviceId]);
  const counts = Object.fromEntries(Object.keys(DEVICE_INGEST_STATES).map((status) => [status,
    status === 'all' ? rows.length : rows.filter((file) => file.ingestStatus === status).length]));
  const folders = [...files.reduce((groups, file) => {
    const folder = deviceFolder(file.path);
    groups.set(folder, (groups.get(folder) || 0) + 1);
    return groups;
  }, new Map())];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = rows.filter((file) =>
    (folderFilter === 'all' || deviceFolder(file.path) === folderFilter)
    && (!normalizedQuery || [file.name, file.path, file.common?.title, file.common?.artist, file.common?.album]
      .some((part) => String(part || '').toLocaleLowerCase().includes(normalizedQuery))));
  const visible = filtered.filter((file) => statusFilter === 'all' || file.ingestStatus === statusFilter);
  const selectable = (file) => file.ingestStatus !== 'saved' && !file.inQueue;
  const canSelect = !disabled && !busy && Boolean(current?.online) && catalog !== null && !checkError;
  const selectableVisible = visible.filter(selectable);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const shown = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  React.useEffect(() => { setPage((prior) => Math.min(prior, pageCount)); }, [pageCount]);

  const refreshDevices = React.useCallback(async () => {
    try {
      const result = await listIngestDevices();
      setDevices(result.devices || []);
      setDeviceId((id) => result.devices?.some((device) => device.id === id)
        ? id : result.devices?.find((device) => device.online)?.id || result.devices?.[0]?.id || '');
    } catch (error) { setMessage(error.message); }
  }, []);
  React.useEffect(() => { void refreshDevices(); }, [refreshDevices]);
  const loadFiles = React.useCallback(async () => {
    const version = ++requestVersion.current;
    if (!deviceId) { setBusy(false); return; }
    setBusy(true);
    setCheckError('');
    setMessage(t('正在检查新增与重复歌曲…'));
    try {
      const [manifest, songs] = await Promise.all([
        sessionGuardRef.current.run((signal) => readManifest(deviceId, signal)),
        loadIngestCatalog((options) => sessionGuardRef.current.run(() => listCatalogSongs(options))),
      ]);
      if (version !== requestVersion.current) return;
      setFiles(manifest.files || []);
      setCatalog(songs);
      const ids = new Set((manifest.files || []).map((file) => file.id));
      setSelected((prior) => new Set([...prior].filter((id) => ids.has(id))));
      setMessage('');
    } catch (error) {
      if (version !== requestVersion.current) return;
      setCatalog(null);
      setCheckError(error.message);
      setMessage('');
    } finally { if (version === requestVersion.current) setBusy(false); }
  }, [deviceId, sessionGuardRef]);
  React.useEffect(() => {
    setFiles([]); setCatalog(null); setSelected(new Set()); setMappings({});
    setFolderFilter('all'); setStatusFilter('new'); setPage(1); setCheckError('');
  }, [deviceId]);
  React.useEffect(() => {
    if (!disabled) void loadFiles();
    return () => { requestVersion.current += 1; };
  }, [loadFiles, savedCount, disabled]);

  const rescan = async () => {
    if (!current?.online) return;
    setBusy(true);
    setMessage(t("正在通知本地设备重新扫描…"));
    try {
      await runDeviceJob(deviceId, { kind: 'refresh' });
      await loadFiles();
      await refreshDevices();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  const selectVisible = (checked) => {
    setSelected((prior) => {
      const next = new Set(prior);
      selectableVisible.forEach((file) => checked ? next.add(file.id) : next.delete(file.id));
      return next;
    });
  };
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((file) => selected.has(file.id));
  const selectedFiles = rows.filter((file) => selected.has(file.id) && selectable(file));
  return <div className="space-y-4">
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-52 flex-1 text-sm font-semibold">{t("本地设备")}<SelectControl disabled={busy || disabled} aria-label={t("本地设备")} value={deviceId} onChange={(event) => setDeviceId(event.target.value)}
          className="mt-1 block w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2">
          {devices.length === 0 && <option value="">{t("没有已连接设备")}</option>}
          {devices.map((device) => <option key={device.id} value={device.id}>
            {device.name} · {device.online ? t("在线") : t("离线")}
          </option>)}
        </SelectControl>
      </label>
      <button type="button" onClick={() => void refreshDevices()} disabled={busy}
        className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm">{t("刷新设备")}</button>
      <button type="button" onClick={() => void rescan()} disabled={disabled || busy || !current?.online}
        className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-50">{t("重新扫描")}</button>
      <button type="button" onClick={() => void loadFiles()} disabled={disabled || busy || !deviceId}
        className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-50">{t('重新检查')}</button>
    </div>
    {current && <p className="text-xs text-[var(--muted)]">
      {current.online ? t("设备在线") : t("设备离线")}{' '}{t("· 配置目录：")}{current.roots.join('、')}
      {current.scannedAt ? t(" · 上次扫描 {p0}", { p0: (new Date(current.scannedAt).toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en')) }) : ''}
    </p>}
    {(message || !deviceId) && <p role="status" className="text-sm text-[var(--muted)]">{message || t("在运行 Node 程序的设备执行 npm run ingest:configure，然后 npm run ingest。")}</p>}
    {checkError && <p role="alert" className="text-sm text-rose-600">{t('查重未完成，暂时不能选择新增。')}{' '}{t(checkError)}</p>}
    {busy && !files.length && <div aria-label={t('正在检查新增与重复歌曲…')} className="space-y-2">
      {[0, 1, 2].map((item) => <div key={item} className="h-24 animate-pulse rounded-xl bg-[var(--line)] motion-reduce:animate-none" />)}
    </div>}
    {!busy && catalog && !files.length && <p className="py-8 text-center text-sm text-[var(--muted)]">{t('此设备尚无扫描结果。')}</p>}
    {files.length > 0 && <>
      <div role="group" aria-label={t('入库分类')} className="flex flex-wrap gap-2">
        {Object.entries(DEVICE_INGEST_STATES).map(([status, label]) => <button key={status} type="button"
          aria-pressed={statusFilter === status} disabled={busy || catalog === null}
          onClick={() => { setStatusFilter(status); setPage(1); }}
          className={'rounded-xl px-3 py-2 text-sm disabled:opacity-50 ' + (statusFilter === status
            ? 'primary-button' : 'border border-[var(--line)] bg-[var(--surface)]')}>
          {t(label)} · {counts[status]}
        </button>)}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!canSelect} onClick={() => {
          setSelected(new Set(filtered.filter((file) => file.ingestStatus === 'new' && selectable(file)).map((file) => file.id)));
          setStatusFilter('new'); setPage(1);
        }} className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-50">{t('只选新增')}</button>
        <button type="button" disabled={!canSelect || !selectedFiles.length} onClick={() => {
          const kept = selectedFiles.filter((file) => file.ingestStatus !== 'duplicate');
          setSelected(new Set(kept.map((file) => file.id)));
          setMessage(t('已排除 {count} 首疑似重复。', { count: selectedFiles.length - kept.length }));
        }} className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-50">{t('排除重复')}</button>
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-semibold">{t("文件夹语言映射")}</summary>
        <p className="mt-1 text-xs text-[var(--muted)]">{t("仅应用于随后加入清单的歌曲。")}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {folders.map(([folder, count]) => <label key={folder}
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-[var(--line)] px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-semibold" title={folder}>{folder} · {count}{' '}{t("首")}</span>
            <SelectControl aria-label={t("{p0} 的语言映射", { p0: (folder) })} value={mappings[folder] || 'folder'}
              onChange={(event) => setMappings((current) => ({ ...current, [folder]: event.target.value }))}
              className="rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] px-2 py-1.5">
              <option value="folder">{t("按目录名判断")}</option>
              <option value="auto">{t("按标签和文字判断")}</option>
              {ALL_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{t(language.label)}</option>)}
            </SelectControl>
          </label>)}
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-3">
        <input aria-label={t("筛选设备歌曲")} placeholder={t("筛选歌名、歌手、专辑或路径")} value={query}
          onChange={(event) => { setQuery(event.target.value); setPage(1); }}
          className="min-w-52 flex-1 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm" />
        <SelectControl aria-label={t("筛选设备目录")} value={folderFilter}
          onChange={(event) => { setFolderFilter(event.target.value); setPage(1); }}
          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm">
          <option value="all">{t("全部目录")}</option>
          {folders.map(([folder]) => <option key={folder} value={folder}>{folder}</option>)}
        </SelectControl>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={allVisibleSelected} disabled={!canSelect || !selectableVisible.length}
            onChange={(event) => selectVisible(event.target.checked)} />{t("选择筛选结果（")}{visible.length}{t("首）")}</label>
        <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-[var(--muted)]">{t("已选")}{' '}{selectedFiles.length} / {files.length}</span>
        <button type="button" disabled={!canSelect || !selectedFiles.length}
          onClick={() => {
            onAdd(selectedFiles, current, mappings);
            setSelected(new Set());
          }}
          className="primary-button rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50">{t("将所选歌曲加入清单")}</button>
        </div>
      </div>
      <div className="space-y-2">
          {shown.map((file, offset) => {
            const guess = resolveDeviceLanguage(file, mappings);
            const title = file.common?.title || file.name.replace(/\.[^.]+$/, '');
            return <article key={file.id}
            className="flex flex-wrap items-start gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3 sm:flex-nowrap sm:p-4">
            <input id={`device-candidate-${file.id}`} type="checkbox" aria-label={t('选择 {title}', { title })} checked={selected.has(file.id) && selectable(file)} disabled={!canSelect || !selectable(file)} className="mt-4 h-5 w-5 shrink-0"
              onChange={(event) => setSelected((prior) => {
                const next = new Set(prior);
                if (event.target.checked) next.add(file.id); else next.delete(file.id);
                return next;
              })} />
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] text-[var(--muted)]">
              <Disc size={21} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <label htmlFor={`device-candidate-${file.id}`} className="block cursor-pointer truncate text-sm font-bold" title={title}>{(page - 1) * PAGE_SIZE + offset + 1}. {title}</label>
              <span className="mt-1 block truncate text-xs text-[var(--muted)]">
                {file.common?.artist || t("歌手未设置")} · {file.common?.album || t("专辑未设置")} · {formatDuration(file.duration)}
              </span>
              <span className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-[var(--line)] px-2 py-0.5">{t(DEVICE_INGEST_STATES[file.ingestStatus])}</span>
                {file.inQueue && <span className="text-[var(--muted)]">{t('已在清单')}</span>}
                <span className="rounded-full border border-[var(--line)] px-2 py-0.5">
                  {getLanguageLabel(guess.code, t("语言待确认"))} · {guess.source === 'folder' ? t("文件夹") : guess.source === 'tag' ? t("标签") : guess.source === 'text' ? t("文字推测") : t("待确认")}
                </span>
                <span className="break-all text-[var(--muted)]">{file.path} · {(file.size / 1024 / 1024).toFixed(1)} MB</span>
              </span>
              {file.matches.length > 0 && <details className="mt-2 text-xs text-[var(--muted)]">
                <summary className="cursor-pointer">{t('查看重复依据（{count}）', { count: file.matches.length })}</summary>
                <ul className="mt-2 space-y-1">
                  {file.matches.slice(0, 20).map((match) => <li key={`${match.source}:${match.id}`}>
                    {match.source === 'catalog' ? t('曲库已有') : t('设备目录内')}{' · '}
                    {match.title} · {match.artist || t('歌手未设置')}{' · '}
                    {match.strength === 'strong' ? t('高度相似') : t('可能重复')}
                  </li>)}
                </ul>
              </details>}
              {file.ingestStatus === 'changed' && <p className="mt-2 text-xs text-[var(--muted)]">{t('文件变化后需重新核对。')}</p>}
              {file.ingestStatus === 'unfinished' && <p className="mt-2 text-xs text-[var(--muted)]">
                {file.ingest?.audio?.status === 'error' ? t(file.ingest.audio.message) : t('媒体已传输，歌曲信息尚未确认。')}
              </p>}
            </div>
          </article>;
          })}
          {!shown.length && <p className="rounded-xl border border-[var(--line)] px-4 py-8 text-center text-sm text-[var(--muted)]">{t("没有符合筛选条件的歌曲。")}</p>}
      </div>
      {visible.length > PAGE_SIZE && <div className="flex items-center justify-end gap-2 text-sm">
        <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>{t("上一页")}</button>
        <span>{page} / {pageCount}</span>
        <button type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>{t("下一页")}</button>
      </div>}
    </>}
  </div>;
}
