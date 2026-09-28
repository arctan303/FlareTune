import React from 'react';
import { listIngestDevices } from '../services/ingestDeviceApi.js';
import Section from './SettingsSection.jsx';

export default function IngestDevicesPanel() {
  const [devices, setDevices] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listIngestDevices();
      setDevices(result.devices || []);
    } catch (cause) { setError(cause.message || '无法读取设备状态。'); }
    finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);

  return <Section title="入库设备">
    <div className="flex justify-end">
      <button type="button" disabled={loading} onClick={() => void refresh()}
        className="rounded-xl border border-[var(--line)] px-3 py-2 text-xs font-semibold disabled:opacity-50">刷新状态</button>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p>}
    {loading && <p role="status" className="mt-3 text-sm text-[var(--muted)]">正在读取设备…</p>}
    {!loading && !error && !devices.length && <p className="mt-3 text-sm text-[var(--muted)]">
      还没有入库设备。在存放音乐的电脑运行 npm run ingest:configure，随后运行 npm run ingest。
    </p>}
    {!loading && devices.length > 0 && <div className="mt-3 space-y-2">
      {devices.map((device) => <article key={device.id}
        className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <strong>{device.name}</strong>
          <span className={'rounded-full px-2 py-0.5 text-xs font-semibold ' +
            (device.online ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400')}>
            {device.online ? '在线' : '离线'}
          </span>
        </div>
        <p className="mt-2 break-all text-xs text-[var(--muted)]">音乐目录：{device.roots?.join('、') || '未配置'}</p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          {device.lastSeenAt ? `最后连接：${new Date(device.lastSeenAt).toLocaleString()}` : '尚无连接记录'}
          {device.scannedAt ? ` · 最后扫描：${new Date(device.scannedAt).toLocaleString()}` : ' · 尚未扫描'}
        </p>
      </article>)}
    </div>}
    <a href="/settings/admin/catalog/new" className="mt-4 inline-flex text-sm font-semibold text-[var(--accent)]">
      前往歌曲入库
    </a>
  </Section>;
}
