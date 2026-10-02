import { getLocale, t } from '../i18n/index.js';
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

  return <Section
    title={t("入库设备")}
    action={
      <button
        type="button"
        disabled={loading}
        onClick={() => void refresh()}
        className="rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-raised)] px-3 py-1.5 text-xs font-semibold text-[var(--ink)] cursor-pointer transition-colors shadow-2xs disabled:opacity-50"
      >
        {t("刷新状态")}
      </button>
    }
  >
    {error && <p role="alert" className="mt-2 text-xs text-rose-600">{t(error)}</p>}
    {loading && <p role="status" className="mt-2 text-xs text-[var(--muted)]">{t("正在读取设备…")}</p>}
    {!loading && !error && !devices.length && <p className="mt-2 text-xs text-[var(--muted)]">{t("还没有入库设备。在存放音乐的电脑运行 npm run ingest:configure，随后运行 npm run ingest。")}</p>}
    {!loading && devices.length > 0 && <div className="mt-2 space-y-2">
      {devices.map((device) => <article key={device.id}
        className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-3.5 sm:p-4 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm font-bold text-[var(--ink)]">{device.name}</strong>
          <span className={'rounded-full px-2 py-0.5 text-[10px] font-semibold ' +
            (device.online ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400')}>
            {device.online ? t("在线") : t("离线")}
          </span>
        </div>
        <p className="mt-1.5 break-all text-xs text-[var(--muted)]">{t("音乐目录：")}{device.roots?.join('、') || t("未配置")}</p>
        <p className="mt-1 text-[11px] text-[var(--muted)]">
          {device.lastSeenAt ? t("最后连接：{p0}", { p0: (new Date(device.lastSeenAt).toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en')) }) : t("尚无连接记录")}
          {device.scannedAt ? t(" · 最后扫描：{p0}", { p0: (new Date(device.scannedAt).toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en')) }) : t(" · 尚未扫描")}
        </p>
      </article>)}
    </div>}
    <div className="pt-2">
      <a href="/settings/admin/catalog/new" className="inline-flex text-xs font-semibold text-[var(--accent)] hover:underline">{t("前往歌曲入库")}</a>
    </div>
  </Section>;
}
