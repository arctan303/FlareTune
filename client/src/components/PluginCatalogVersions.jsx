import React from 'react';
import { t } from '../i18n/index.js';
import { catalogCandidateState, catalogVersionAvailability, sameCatalogTarget, catalogTargetKey } from '../plugins/catalog.js';
import { comparePluginVersions } from '../../../shared/plugins/manifest.js';
import SettingsSection from './SettingsSection.jsx';
import SelectControl from './SelectControl.jsx';

const sameVersion = sameCatalogTarget;
const sourceName = (data, id, rows = []) => id === 'workspace' ? t('当前部署')
  : data.sources.find(source => source.id === id)?.name || rows.find(row => row.sourceId === id)?.sourceName || id;
const incompatible = reason => reason && !['current', 'selected', 'not_newer', 'source_conflict', 'source_unavailable'].includes(reason);

export function PluginVersionSummary({ model }) {
  return <dl className="plugin-version-summary">
    <div><dt>{t('当前版本')}</dt><dd>{model.running?.version || t('未安装')}</dd></div>
    <div><dt>{t('最新版本')}</dt><dd>{model.latest?.version || t(model.ambiguousSource ? '请选择来源' : '暂无法确认')}</dd></div>
    {model.pending && <div className="text-[var(--accent)]"><dt>{t(model.pending.operation === 'uninstall' ? '待卸载' : '待应用版本')}</dt><dd>{model.desired?.version || model.running?.version}</dd></div>}
  </dl>;
}

export function PluginCatalogNotice({ model, data }) {
  let message = '';
  if (model.ambiguousSource) message = t('选择来源后查看最新版本并安装。');
  else if (!model.latest) message = t('来源暂不可用，无法确认最新版本。');
  else {
    const state = catalogCandidateState(data, model.latest);
    if (incompatible(state.reason)) message = t('最新版本与当前宿主或依赖不兼容。');
    else if (model.running && model.running.version === model.latest.version && !sameVersion(model.running, model.latest)) message = t('包内容已变化，仅供核验。');
    else if (model.running && comparePluginVersions(model.running.version, model.latest.version) > 0) message = t('当前运行版本高于目录版本。');
  }
  return message || (model.update && !sameVersion(model.update, model.latest)) ? <div className="mt-3 space-y-1 text-xs leading-relaxed text-[var(--muted)]">
    {message && <p role="status">{message}</p>}
    {model.update && !sameVersion(model.update, model.latest) && <p>{t('可更新至 {p0}', { p0: model.update.version })}</p>}
  </div> : null;
}

export default function PluginCatalogVersions({ model, data, onSourceChange, renderOverviewLink }) {
  return <SettingsSection title={t('所有版本')} action={<SelectControl aria-label={t('版本来源')} value={model.sourceId} onChange={event => onSourceChange(event.target.value)}
    className="max-w-full w-52 rounded-xl border border-[var(--line)] bg-[var(--surface)] text-sm text-[var(--ink)]">
    {!model.sourceId && <option value="">{t('请选择来源')}</option>}
    {model.sourceIds.map(id => <option key={id} value={id}>{sourceName(data, id, model.versions)}</option>)}
  </SelectControl>}>
    <ul className="plugin-version-list">
      {model.versions.map(row => {
        const state = catalogCandidateState(data, row);
        const compatibility = catalogVersionAvailability(data, row);
        const current = sameVersion(row, model.running), pending = model.pending && sameVersion(row, model.desired);
        const replacedPackage = model.versions.some(other => other !== row && other.sourceId === row.sourceId && other.version === row.version && !sameVersion(other, row));
        const identity = <><strong>{row.version}</strong>{!model.sourceId && <span className="text-[var(--muted)]">{sourceName(data, row.sourceId, model.versions)}</span>}
          {replacedPackage && <code className="text-xs text-[var(--muted)]" title={row.source?.sha256 || row.source?.sourceDigest}>{(row.source?.sha256 || row.source?.sourceDigest || '').slice(0, 12)}</code>}</>;
        return <li key={catalogTargetKey(row)} className="plugin-version-row">
          {replacedPackage && !sameVersion(row, model.row) ? <div className="plugin-version-row__link">{identity}</div> : renderOverviewLink(row, { presentation: 'summary', className: 'plugin-version-row__link',
            'aria-label': row.version + ' · ' + sourceName(data, row.sourceId, model.versions),
            'aria-current': sameVersion(row, model.row) ? 'page' : undefined, children: identity })}
          <div className="plugin-version-row__state">
            {current && <span>{t('当前运行')}</span>}
            {pending && <span>{t('待应用版本')}</span>}
            {sameVersion(row, model.viewLatest) && <span>{t('最新版本')}</span>}
            {state.reason === 'source_conflict' && <span>{t('其他来源，仅供查看。')}</span>}
            {state.reason === 'source_unavailable' && <span>{t('来源暂不可用')}</span>}
            {!compatibility.available && <span>{t('宿主或依赖不兼容')}</span>}
            {!current && !pending && state.reason === 'not_newer' && <span>{t('历史版本，仅供查看。')}</span>}
            {replacedPackage && !current && <span>{t('包内容已变化，仅供核验。')}</span>}
          </div>
        </li>;
      })}
    </ul>
  </SettingsSection>;
}
