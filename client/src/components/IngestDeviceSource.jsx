import React from 'react';
import { getDeviceManifest, listIngestDevices, runDeviceJob } from '../services/ingestDeviceApi.js';

const PAGE_SIZE = 25;

export default function IngestDeviceSource({ disabled, onAdd }) {
  const [devices, setDevices] = React.useState([]);
  const [deviceId, setDeviceId] = React.useState('');
  const [files, setFiles] = React.useState([]);
  const [selected, setSelected] = React.useState(new Set());
  const [query, setQuery] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const current = devices.find((device) => device.id === deviceId);
  const visible = files.filter((file) => !query || [file.name, file.path, file.common?.artist]
    .some((part) => String(part || '').toLocaleLowerCase().includes(query.toLocaleLowerCase())));
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
      setPage(1);
      setMessage(`扫描完成，共 ${result.files?.length || 0} 首音频。`);
      await refreshDevices();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  const selectPage = (checked) => {
    setSelected((prior) => {
      const next = new Set(prior);
      shown.forEach((file) => checked ? next.add(file.id) : next.delete(file.id));
      return next;
    });
  };
  const pageSelected = shown.length > 0 && shown.every((file) => selected.has(file.id));
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
      <div className="flex flex-wrap items-center gap-3">
        <input aria-label="筛选设备歌曲" placeholder="筛选歌名、歌手或路径" value={query}
          onChange={(event) => { setQuery(event.target.value); setPage(1); }}
          className="min-w-52 flex-1 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm" />
        <span className="text-xs text-[var(--muted)]">已选 {selected.size} / {files.length}</span>
        <button type="button" disabled={disabled || busy || !current?.online || !selected.size}
          onClick={() => {
            onAdd(files.filter((file) => selected.has(file.id)), current);
            setSelected(new Set());
          }}
          className="primary-button rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50">
          将所选歌曲加入预览
        </button>
      </div>
      <div className="rounded-xl border border-[var(--line)]">
        <label className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-sm">
          <input type="checkbox" checked={pageSelected} disabled={disabled || !current?.online}
            onChange={(event) => selectPage(event.target.checked)} />
          选择当前页（{shown.length} 首）
        </label>
        <div className="max-h-80 overflow-y-auto">
          {shown.map((file) => <label key={file.id}
            className="flex items-center gap-3 border-b border-[var(--line)] px-3 py-2 text-sm last:border-b-0">
            <input type="checkbox" checked={selected.has(file.id)} disabled={disabled || !current?.online}
              onChange={(event) => setSelected((prior) => {
                const next = new Set(prior);
                if (event.target.checked) next.add(file.id); else next.delete(file.id);
                return next;
              })} />
            <span className="min-w-0 flex-1 truncate" title={file.path}>
              <strong>{file.common?.title || file.name.replace(/\.[^.]+$/, '')}</strong>
              <span className="ml-2 text-[var(--muted)]">{file.common?.artist || file.path}</span>
            </span>
          </label>)}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 text-sm">
        <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>{page} / {pageCount}</span>
        <button type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
    </>}
  </div>;
}
