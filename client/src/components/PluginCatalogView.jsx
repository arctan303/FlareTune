import React from 'react';
import { t, useLocale } from '../i18n/index.js';
import { localizePlugin } from '../plugins/registry.js';
import { catalogCandidateState, catalogGroups, sameCatalogTarget } from '../plugins/catalog.js';
import SelectControl from './SelectControl.jsx';
import { SettingsActions, SettingsButton } from './SettingsControls.jsx';
import PluginConfirmDialog from './PluginConfirmDialog.jsx';
import { PluginDeliveryStatus } from './PluginDeliveryView.jsx';
import { PluginVersionSummary, PluginCatalogNotice } from './PluginCatalogVersions.jsx';
import { activePluginBuild } from '../hooks/usePluginDelivery.js';

export default function PluginCatalogView({ delivery, renderLinks, renderOverviewLink, renderAvailability }) {
  const locale = useLocale();
  const { data, busy, action } = delivery;
  const [tab, setTab] = React.useState('installed');
  const [sourceId, setSourceId] = React.useState('');
  const [confirmation, setConfirmation] = React.useState(null);
  const locked = busy || activePluginBuild(data.build) || data.build?.resultUnknown;
  const confirmationBlocked = confirmation && (locked || data.pending.some(change => change.id === confirmation.row.id)
    || (confirmation.operation === 'uninstall' ? !sameCatalogTarget(confirmation.row, data.running.find(row => row.id === confirmation.row.id))
      : !catalogCandidateState(data, confirmation.row).available));
  const groups = catalogGroups(data, { sourceId, installedOnly: tab === 'installed' });
  const save = async () => {
    if (!confirmation || confirmationBlocked) return;
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
    {groups.map(model => {
      const row = model.row;
      if (!row) return null;
      const plugin = localizePlugin(row.manifest, locale);
      const candidate = model.running ? model.update : model.ambiguousSource ? null : model.viewLatest;
      const candidateState = candidate ? catalogCandidateState(data, candidate) : null;
      const operation = candidateState?.available ? candidateState.operation : null;
      const availabilityNode = model.running && renderAvailability ? renderAvailability(row.id) : null;
      const sourceName = model.ambiguousSource ? t('{p0} 个来源', { p0: model.sourceIds.length })
        : row.sourceId === 'workspace' ? t('当前部署') : row.sourceName;
      const linkRow = model.ambiguousSource ? { ...row, sourceId: undefined, version: undefined } : row;
      return <section key={model.id} className="plugin-catalog-card wallpaper-content-surface">
        <div className="plugin-catalog-card__header">
          {renderOverviewLink(linkRow, { presentation: 'summary', className: 'plugin-catalog-card__summary', children: <>
            <div className="plugin-catalog-card__identity">
              <h2>{plugin.name}</h2>
              <span className="plugin-catalog-card__meta plugin-catalog-card__source" title={sourceName}>{sourceName}</span>
            </div>
            <p className="plugin-catalog-card__description">{plugin.description}</p>
            <PluginVersionSummary model={model} />
          </> })}
          <SettingsActions className="plugin-catalog-card__actions">
          {model.running && renderLinks(row.id, { compact: true })}
          {operation && <SettingsButton variant={operation === 'install' ? 'primary' : 'quiet'} disabled={locked || !!model.pending}
            onClick={() => setConfirmation({ row: candidate, operation })}>{t(operation === 'update' ? '更新插件' : '安装插件')}</SettingsButton>}
          {tab === 'installed' ? <>
            <SettingsButton variant="danger" className="plugin-icon-action" aria-label={t('卸载插件')} title={t('卸载插件')} disabled={locked || !!model.pending || !model.desired} onClick={() => setConfirmation({ row: model.running, operation: 'uninstall' })}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" /></svg>
              <span className="sr-only">{t('卸载插件')}</span>
            </SettingsButton>
          </> : model.running && !operation && <span className="text-xs font-medium text-[var(--muted)]">{t('已安装')}</span>}
          </SettingsActions>
        </div>
        <PluginCatalogNotice model={model} data={data} />
        {availabilityNode && <div className="plugin-catalog-card__state text-sm text-[var(--muted)]">
          {availabilityNode}
        </div>}
      </section>;
    })}
    {!groups.length && <p role="status" className="text-sm text-[var(--muted)]">{t(tab === 'installed' ? '暂无已安装插件，可前往发现插件。' : '此来源暂无可发现的插件，请到来源与部署刷新目录。')}</p>}
    {confirmation && <PluginConfirmDialog installed={confirmation.operation === 'uninstall'} operation={confirmation.operation} deferred
      pluginName={localizePlugin(confirmation.row.manifest, locale).name} fromVersion={data.running.find(row => row.id === confirmation.row.id)?.version}
      targetVersion={confirmation.operation !== 'uninstall' ? confirmation.row.version : null}
      sourceName={confirmation.row.sourceId === 'workspace' ? t('当前部署') : confirmation.row.sourceName}
      deliveryMode={data.settings.mode} busy={busy} confirmDisabled={confirmationBlocked}
      blockedMessage={confirmationBlocked ? t(data.build?.resultUnknown ? '请先核实远端构建结果，再修改待应用变更。'
        : activePluginBuild(data.build) ? '构建正在进行，请完成后再修改插件组合。' : '插件变更已被其他操作更新，请刷新后重试。') : ''}
      error={delivery.error} onClose={() => setConfirmation(null)} onConfirm={save} />}
  </>;
}
