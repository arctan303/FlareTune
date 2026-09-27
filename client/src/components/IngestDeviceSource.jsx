import React from 'react';
import { Disc } from 'lucide-react';
import { ALL_LANGUAGES, getLanguageLabel } from '../constants/language.js';
import { deviceFolder, resolveDeviceLanguage } from '../utils/deviceFolderLanguage.js';
import { getDeviceManifest, listIngestDevices, runDeviceJob } from '../services/ingestDeviceApi.js';

const PAGE_SIZE = 25;
const formatDuration = (seconds) => seconds
  ? `${Math.floor(Number(seconds) / 60)}:${String(Math.round(Number(seconds)) % 60).padStart(2, '0')}` : '时长未知';

export default function IngestDeviceSource({ disabled, onAdd }) {
  const [devices, setDevices] = React.useState([]);
  const [deviceId, setDeviceId] = React.useState('');
  const [files, setFiles] = React.useState([]);
  const [selected, setSelected] = React.useState(new Set());
  const [mappings, setMappings] = React.useState({});
  const [query, setQuery] = React.useState('');
  const [folderFilter, setFolderFilter] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const current = devices.find((device) => device.id === deviceId);
  const folders = [...files.reduce((groups, file) => {
    const folder = deviceFolder(file.path);
    groups.set(folder, (groups.get(folder) || 0) + 1);
    return groups;
  }, new Map())];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = files.filter((file) =>
    (folderFilter === 'all' || deviceFolder(file.path) === folderFilter)
    && (!normalizedQuery || [file.name, file.path, file.common?.title, file.common?.artist, file.common?.album]
      .some((part) => String(part || '').toLocaleLowerCase().includes(normalizedQuery))));
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const shown = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const refreshDevices = React.useCallback(async () => {
    try {
      const result = await listIngestDevices();
      setDevices(result.devices || []);
      setDeviceId((id) => result.devices?.some((device) => device.id === id)
        ? id : result.devices?.find((device) => device.online)?.id || result.devices?.[0]?.id || '');
    } catch (error) { setMessage(error.message); }
  }, []);
  React.useEffect(() => { void refreshDevices(); }, [refreshDevices]);
  React.useEffect(() => {
    if (!deviceId) { setFiles([]); return undefined; }
    let active = true;
    setBusy(true);
    void getDeviceManifest(deviceId).then((result) => {
      if (!active) return;
      setFiles(result.files || []);
      setSelected(new Set());
      setMappings({});
      setFolderFilter('all');
      setPage(1);
      setMessage(result.files?.length ? `已读取 ${result.files.length} 首候选歌曲。` : '此设备尚无扫描结果。');
    }).catch((error) => { if (active) setMessage(error.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [deviceId]);

  const rescan = async () => {
    if (!current?.online) return;
    setBusy(true);
    setMessage('正在通知本地设备重新扫描…');
    try {
      await runDeviceJob(deviceId, { kind: 'refresh' });
      const result = await getDeviceManifest(deviceId);
      setFiles(result.files || []);
      setSelected(new Set());
      setFolderFilter('all');
      setPage(1);
      setMessage(`扫描完成，共 ${result.files?.length || 0} 首音频。`);
      await refreshDevices();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  const selectVisible = (checked) => {
    setSelected((prior) => {
      const next = new Set(prior);
      visible.forEach((file) => checked ? next.add(file.id) : next.delete(file.id));
      return next;
    });
  };
  const allVisibleSelected = visible.length > 0 && visible.every((file) => selected.has(file.id));
  return <div className="space-y-4">
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-52 flex-1 text-sm font-semibold">本地设备
        <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}
          className="mt-1 block w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2">
          {devices.length === 0 && <option value="">没有已连接设备</option>}
          {devices.map((device) => <option key={device.id} value={device.id}>
            {device.name} · {device.online ? '在线' : '离线'}
          </option>)}
        </select>
      </label>
      <button type="button" onClick={() => void refreshDevices()} disabled={busy}
        className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm">刷新设备</button>
      <button type="button" onClick={() => void rescan()} disabled={disabled || busy || !current?.online}
        className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-50">重新扫描</button>
    </div>
    {current && <p className="text-xs text-[var(--muted)]">
      {current.online ? '设备在线' : '设备离线'} · 配置目录：{current.roots.join('、')}
      {current.scannedAt ? ` · 上次扫描 ${new Date(current.scannedAt).toLocaleString()}` : ''}
    </p>}
    <p role="status" className="text-sm text-[var(--muted)]">{message || '在运行 Node 程序的设备执行 npm run ingest:configure，然后 npm run ingest。'}</p>
    {files.length > 0 && <>
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
        <h3 className="text-sm font-bold">文件夹语言映射</h3>
        <p className="mt-1 text-xs text-[var(--muted)]">按目录名映射 zh、en、jp、纯音乐等；也可单独指定某个目录。设置仅应用于随后加入清单的歌曲，仍可逐首编辑。</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {folders.map(([folder, count]) => <label key={folder}
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-[var(--line)] px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-semibold" title={folder}>{folder} · {count} 首</span>
            <select aria-label={`${folder} 的语言映射`} value={mappings[folder] || 'folder'}
              onChange={(event) => setMappings((current) => ({ ...current, [folder]: event.target.value }))}
              className="rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] px-2 py-1.5">
              <option value="folder">按目录名判断</option>
              <option value="auto">按标签和文字判断</option>
              {ALL_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
            </select>
          </label>)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input aria-label="筛选设备歌曲" placeholder="筛选歌名、歌手、专辑或路径" value={query}
          onChange={(event) => { setQuery(event.target.value); setPage(1); }}
          className="min-w-52 flex-1 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm" />
        <select aria-label="筛选设备目录" value={folderFilter}
          onChange={(event) => { setFolderFilter(event.target.value); setPage(1); }}
          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm">
          <option value="all">全部目录</option>
          {folders.map(([folder]) => <option key={folder} value={folder}>{folder}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={allVisibleSelected} disabled={disabled || !current?.online || !visible.length}
            onChange={(event) => selectVisible(event.target.checked)} />
          选择筛选结果（{visible.length} 首）
        </label>
        <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-[var(--muted)]">已选 {selected.size} / {files.length}</span>
        <button type="button" disabled={disabled || busy || !current?.online || !selected.size}
          onClick={() => {
            onAdd(files.filter((file) => selected.has(file.id)), current, mappings);
            setSelected(new Set());
          }}
          className="primary-button rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50">
          将所选歌曲加入清单
        </button>
        </div>
      </div>
      <div className="space-y-2">
          {shown.map((file, offset) => {
            const guess = resolveDeviceLanguage(file, mappings);
            const title = file.common?.title || file.name.replace(/\.[^.]+$/, '');
            return <label key={file.id}
            className="flex cursor-pointer flex-wrap items-start gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3 sm:flex-nowrap sm:p-4">
            <input type="checkbox" checked={selected.has(file.id)} disabled={disabled || !current?.online} className="mt-4 shrink-0"
              onChange={(event) => setSelected((prior) => {
                const next = new Set(prior);
                if (event.target.checked) next.add(file.id); else next.delete(file.id);
                return next;
              })} />
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] text-[var(--muted)]">
              <Disc size={21} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-sm" title={title}>{(page - 1) * PAGE_SIZE + offset + 1}. {title}</strong>
              <span className="mt-1 block truncate text-xs text-[var(--muted)]">
                {file.common?.artist || '歌手未设置'} · {file.common?.album || '专辑未设置'} · {formatDuration(file.duration)}
              </span>
              <span className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-[var(--line)] px-2 py-0.5">
                  {getLanguageLabel(guess.code, '语言待确认')} · {guess.source === 'folder' ? '文件夹' : guess.source === 'tag' ? '标签' : guess.source === 'text' ? '文字推测' : '待确认'}
                </span>
                <span className="break-all text-[var(--muted)]">{file.path} · {(file.size / 1024 / 1024).toFixed(1)} MB</span>
              </span>
            </span>
          </label>;
          })}
          {!shown.length && <p className="rounded-xl border border-[var(--line)] px-4 py-8 text-center text-sm text-[var(--muted)]">没有符合筛选条件的歌曲。</p>}
      </div>
      {visible.length > PAGE_SIZE && <div className="flex items-center justify-end gap-2 text-sm">
        <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>{page} / {pageCount}</span>
        <button type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>下一页</button>
      </div>}
    </>}
  </div>;
}
