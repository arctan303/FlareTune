import React from 'react';
import { t, useLocale } from '../i18n/index.js';
import { localizePlugin } from '../plugins/registry.js';
import SelectControl from './SelectControl.jsx';
import { SettingsActions, SettingsButton } from './SettingsControls.jsx';
import PluginConfirmDialog from './PluginConfirmDialog.jsx';
import { PluginDeliveryStatus } from './PluginDeliveryView.jsx';
import { activePluginBuild } from '../hooks/usePluginDelivery.js';
const compareVersions = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
};

export default function PluginCatalogView({ delivery, renderLinks, renderOverviewLink, renderAvailability }) {
  const locale = useLocale();
  const { data, busy, action } = delivery;
  const [tab, setTab] = React.useState('installed');
  const [sourceId, setSourceId] = React.useState('');
  const [confirmation, setConfirmation] = React.useState(null);
  const locked = busy || activePluginBuild(data.build) || data.build?.resultUnknown;
  const rows = (tab === 'installed' ? data.running : data.catalog).filter(row => !sourceId || row.sourceId === sourceId);
  const save = async () => {
    if (!confirmation) return;
    const { row, operation } = confirmation;
    try {
      const updated = await action('/selection', 'PUT', { pluginId: row.id, installed: operation !== 'uninstall', sourceId: row.sourceId, version: row.version, trustCode: true });
      if (updated) setConfirmation(null);
    } catch { /* The resource provides safe feedback. */ }
  };
  return <>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div role="group" aria-label={t('插件列表')} className="inline-flex items-center gap-1 rounded-xl border border-[var(--line)] bg-current/5 p-1">
        {[['installed', '已安装'], ['discover', '发现插件']].map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id}
          onClick={() => setTab(id)} className={`min-h-9 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-all cursor-pointer ${tab === id ? 'bg-[var(--surface)] text-[var(--ink)] shadow-2xs' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}>{t(label)}</button>)}
      </div>
      <SelectControl aria-label={t('来源')} className="w-40 rounded-xl border border-[var(--line)] bg-[var(--surface)] text-xs font-medium text-[var(--ink)]" value={sourceId} onChange={event => setSourceId(event.target.value)}>
        <option value="">{t('全部来源')}</option><option value="workspace">{t('当前部署')}</option>
        {data.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
      </SelectControl>
    </div>
    {!!data.pending.length && <PluginDeliveryStatus delivery={delivery} />}
    {rows.map(row => {
      const plugin = localizePlugin(row.manifest, locale);
      const running = data.running.find(item => item.id === row.id);
      const target = data.desired.find(item => item.id === row.id);
      const changed = data.pending.find(item => item.id === row.id);
      const current = running?.version === row.version && running?.sourceId === row.sourceId;
      const selected = target?.version === row.version && target?.sourceId === row.sourceId;
      const availableUpdate = data.catalog.filter(item => item.id === row.id && item.sourceId === row.sourceId && item.version !== row.version
        && compareVersions(item.version, row.version) > 0).sort((a, b) => compareVersions(b.version, a.version))[0];
      const availabilityNode = current && renderAvailability ? renderAvailability(row.id) : null;
      return <section key={`${row.sourceId}:${row.id}:${row.version}`} className="plugin-catalog-card wallpaper-content-surface">
        <div className="plugin-catalog-card__header">
          {renderOverviewLink(row, { presentation: 'summary', className: 'plugin-catalog-card__summary', children: <>
            <div className="plugin-catalog-card__identity">
              <h2>{plugin.name}</h2>
              <span className="plugin-catalog-card__meta">{row.version}{' · '}{row.sourceId === 'workspace' ? t('当前部署') : row.sourceName}</span>
            </div>
            <p className="plugin-catalog-card__description">{plugin.description}</p>
          </> })}
          <SettingsActions className="plugin-catalog-card__actions">
          {current && renderLinks(row.id, { compact: true })}
          {tab === 'installed' ? <>
            {availableUpdate && <SettingsButton disabled={locked || !!changed} onClick={() => setConfirmation({ row: availableUpdate, operation: 'update' })}>{t('更新插件')}</SettingsButton>}
            <SettingsButton variant="danger" className="plugin-icon-action" aria-label={t('卸载插件')} title={t('卸载插件')} disabled={locked || !target} onClick={() => setConfirmation({ row, operation: 'uninstall' })}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" /></svg>
              <span className="sr-only">{t('卸载插件')}</span>
            </SettingsButton>
          </> : current ? <span className="px-2 text-xs font-medium text-[var(--muted)]">{t('已安装')}</span> : <SettingsButton variant="primary" disabled={locked || selected}
            onClick={() => setConfirmation({ row, operation: running ? 'update' : 'install' })}>{t(selected ? '已加入待应用变更' : running ? '更新插件' : '安装插件')}</SettingsButton>}
          </SettingsActions>
        </div>
        {(changed || availabilityNode) && <div className="plugin-catalog-card__state space-y-2 text-sm text-[var(--muted)]">
          {changed && <p role="status" className="text-xs font-medium text-[var(--accent)]">{t(changed.operation === 'uninstall' ? '待卸载' : changed.operation === 'update' ? '待更新' : '待安装')}</p>}
          {availabilityNode}
        </div>}
      </section>;
    })}
    {!rows.length && <p role="status" className="text-sm text-[var(--muted)]">{t(tab === 'installed' ? '暂无已安装插件，可前往发现插件。' : '此来源暂无可发现的插件，请到来源与部署刷新目录。')}</p>}
    {confirmation && <PluginConfirmDialog installed={confirmation.operation === 'uninstall'} operation={confirmation.operation} deferred
      deliveryMode={data.settings.mode} busy={busy} error={delivery.error} onClose={() => setConfirmation(null)} onConfirm={save} />}
  </>;
}
