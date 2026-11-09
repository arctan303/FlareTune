import React from 'react';
import { t, useLocale } from '../i18n/index.js';
import { UI_LANGUAGES } from '../../../shared/uiLanguages.js';
import { usePlugins } from '../hooks/usePlugins.js';
import { getPlugin, getPluginPages, getPluginAvailability, isPluginVisibleToRole, localizePlugin } from '../plugins/registry.js';
import { formatPath, syncBrowserHistory } from '../utils/navigation.js';
import SettingsSection from './SettingsSection.jsx';
import SettingsSkeleton from './SettingsSkeleton.jsx';
import { SettingsActions, SettingsButton } from './SettingsControls.jsx';
import PluginConfirmDialog from './PluginConfirmDialog.jsx';
import PluginContentBoundary from './PluginContentBoundary.jsx';
import { usePluginDelivery, activePluginBuild } from '../hooks/usePluginDelivery.js';
import PluginDeliveryView, { PluginDeliveryStatus } from './PluginDeliveryView.jsx';
import PluginCatalogView from './PluginCatalogView.jsx';

const detailRoute = (id, page = 'overview') => ({ type: 'page', page: 'plugin', pluginId: id, pluginPage: page });
const metadataText = (plugin, field) => plugin?.supportedLocales?.length ? plugin[field] : t(plugin?.[field] || '');
const navigate = (event, route) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  event.preventDefault(); syncBrowserHistory(formatPath(route));
};
export function PluginLink({ route, children, className = '' }) {
  return <a href={formatPath(route)} onClick={event => navigate(event, route)}
    className={'settings-button no-underline ' + className}>{children}</a>;
}

export const pluginAvailabilityMessage = reason => ({
  not_installed: '此插件尚未安装，请联系管理员。',
  incompatible_version: '插件版本与当前网页不兼容，请刷新网页后重试。',
  host_incompatible: '插件与当前宿主版本不兼容。',
  missing_dependency: '插件所需依赖尚不可用，请先检查依赖。',
  dependency_not_installed: '插件所需依赖尚不可用，请先检查依赖。',
  incompatible_dependency: '插件所需依赖版本不兼容。',
  dependency_cycle: '插件依赖存在循环，请联系管理员。',
  dependency_unavailable: '插件所需依赖尚不可用，请先检查依赖。',
  data_migration_required: '插件需要完成数据更新，请联系管理员。',
  data_version_incompatible: '插件数据版本不兼容，请检查插件版本。',
  deployment_pending: '插件的新部署尚未确认，确认完成后才能使用。',
}[reason] || '插件当前不可用，请刷新后重试。');

export function PluginAvailability({ plugin, availability }) {
  const locale = useLocale();
  const dependencies = Object.entries(plugin.dependencies || {});
  const optional = Object.entries(availability?.optionalFeatures || {});
  if (availability?.available !== false && dependencies.length === 0 && optional.length === 0) return null;
  return <div className="space-y-3 text-sm text-[var(--muted)]">
    {availability?.available === false && <p role="status">{t(pluginAvailabilityMessage(availability.reason))}</p>}
    {dependencies.length > 0 && <div><p className="font-medium text-[var(--ink)]">{t('必需依赖')}</p>
      <ul className="mt-1 space-y-1">{dependencies.map(([id, dependency]) => <li key={id}>{metadataText(localizePlugin(getPlugin(id), locale), 'name') || id}{' · API ' + dependency.apiVersion + (dependency.version ? ' · ' + dependency.version : '')}</li>)}</ul>
    </div>}
    {optional.length > 0 && <div><p className="font-medium text-[var(--ink)]">{t('可选功能')}</p>
      <ul className="mt-1 space-y-1">{optional.map(([feature, state]) => <li key={feature}>{t(feature)}{' · ' + t(state.available ? '可用' : '不可用')}</li>)}</ul>
    </div>}
  </div>;
}

export default function PluginSettingsView({ route, session }) {
  const locale = useLocale();
  const isAdmin = session?.authenticated === true && session.user?.role === 'admin';
  const legacyAdmin = route.page === 'settings' && route.section === 'admin-plugins';
  const section = route.pluginId ? 'detail' : legacyAdmin || route.section === 'install' ? 'list'
    : route.section === 'sources' ? 'delivery' : route.section || 'list';
  const management = section === 'delivery';
  const denied = !session?.authenticated || (management && !isAdmin);
  const resource = usePlugins(denied ? null : session, { admin: !denied && isAdmin });
  const delivery = usePluginDelivery(!denied && isAdmin ? session : null);
  const runningRow = delivery.data?.running.find(entry => entry.id === route.pluginId);
  const deliveryRow = route.catalogSource
    ? delivery.data?.catalog.find(entry => entry.id === route.pluginId && entry.sourceId === route.catalogSource && entry.version === route.catalogVersion)
    : runningRow || delivery.data?.catalog.find(entry => entry.id === route.pluginId);
  const plugin = localizePlugin(route.catalogSource ? deliveryRow?.manifest : getPlugin(route.pluginId) || deliveryRow?.manifest, locale);
  const row = plugin ? resource.plugins.find(entry => entry.id === plugin.id) : null;
  const installed = row?.installed === true && (!route.catalogSource || (runningRow?.sourceId === route.catalogSource && runningRow?.version === route.catalogVersion));
  const installedIds = resource.installedIds || resource.plugins.filter(entry => entry.installed).map(entry => entry.id);
  const availabilityFor = id => getPluginAvailability(id, { installedIds, availabilityById: resource.availabilityById });
  const availability = plugin ? availabilityFor(plugin.id) : null;
  const pages = getPluginPages(plugin, { isAdmin, installed, available: availability?.available, authenticated: !!session?.authenticated });
  const pageId = route.pluginPage || route.pluginSection || 'overview';
  const selected = pages.find(page => page.id === pageId);
  const visibleDetail = isAdmin || (installed && plugin && isPluginVisibleToRole(plugin, session?.user?.role));
  const [confirm, setConfirm] = React.useState(false);
  React.useEffect(() => { setConfirm(false); }, [route.pluginId, route.catalogSource, route.catalogVersion, session?.user?.accountId, session?.csrfToken, isAdmin]);
  const save = async () => {
    if (!plugin || resource.busy || delivery.busy || denied || !isAdmin) return;
    try {
      if (confirm === 'upgrade' && row) await resource.setInstalled(plugin.id, true, row.revision);
      else {
        const entry = confirm === 'uninstall' ? delivery.data?.running.find(item => item.id === plugin.id) : deliveryRow;
        if (!entry) return;
        if (!await delivery.action('/selection', 'PUT', { pluginId: plugin.id, installed: confirm !== 'uninstall', sourceId: entry.sourceId, version: entry.version, trustCode: true })) return;
      }
      setConfirm(false); void resource.refresh().catch(() => {});
    }
    catch { /* The resource exposes a fixed, safe error. */ }
  };
  if (!session?.authenticated) return <p role="alert">{t('请先登录后使用插件。')}</p>;
  if (denied) return <p role="alert">{t('仅管理员可管理站点插件。')}</p>;
  const title = plugin ? selected?.labelKey ? selected.label : t(selected?.label || '概览') : t(section === 'delivery' ? '来源与部署' : '插件列表');
  const links = (item, state) => {
    const itemPages = getPluginPages(item, { isAdmin, installed: true, available: state?.available, authenticated: true });
    const service = itemPages.find(page => page.kind === 'service');
    const settings = itemPages.find(page => page.kind === 'settings' && page.id !== 'overview');
    if (!service && !settings) return null;
    return <>
      {service && <PluginLink route={detailRoute(item.id, service.id)}>{t('打开')}</PluginLink>}
      {settings && <PluginLink route={detailRoute(item.id, settings.id)}>{t('设置')}</PluginLink>}
    </>;
  };
  const entries = resource.plugins.filter(entry => entry.installed)
    .filter(entry => { const item = getPlugin(entry.id); return item && (isAdmin || isPluginVisibleToRole(item, session.user.role)); });
  return <div className="app-page mx-auto w-full max-w-4xl space-y-5 pb-28">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-4">
      <h1 className="text-xl font-bold tracking-tight text-[var(--ink)] sm:text-2xl">{title}</h1>
      {resource.loaded && <SettingsButton disabled={resource.loading || resource.busy || delivery.busy} onClick={() => { void resource.refresh().catch(() => {}); if (isAdmin) void delivery.refresh(); }}>{t('刷新')}</SettingsButton>}
    </header>
    {resource.demo ? <p role="status">{t('演示模式无法安装或管理插件。')}</p>
      : !resource.loaded && resource.loading ? <SettingsSkeleton cards={1} rows={2} />
        : !resource.loaded ? <div className="space-y-3"><p role="alert">{t(resource.error || '插件列表加载失败，请重试。')}</p>
          <SettingsButton onClick={() => { void resource.refresh().catch(() => {}); }}>{t('重试')}</SettingsButton></div>
          : !route.pluginId && isAdmin && section !== 'missing' ? !delivery.data
            ? <div className="space-y-3">{delivery.loading ? <SettingsSkeleton cards={2} rows={2} /> : <><p role="alert">{t(delivery.error || '插件列表加载失败，请重试。')}</p><SettingsButton onClick={() => { void delivery.refresh(); }}>{t('重试')}</SettingsButton></>}</div>
            : <>
              {section === 'delivery' ? <PluginDeliveryView key={session.user.accountId + session.csrfToken} delivery={delivery} />
                : <PluginCatalogView key={session.user.accountId + session.csrfToken} delivery={delivery}
                  renderOverviewLink={entry => <PluginLink route={{ ...detailRoute(entry.id), catalogSource: entry.sourceId, catalogVersion: entry.version }}>{t('查看插件')}</PluginLink>}
                  renderLinks={id => links(getPlugin(id), availabilityFor(id))}
                  renderAvailability={id => { const item = getPlugin(id); return item ? <PluginAvailability plugin={item} availability={availabilityFor(id)} /> : null; }} />}
              {delivery.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(delivery.error)}</p>}
            </>
            : section === 'missing' ? <p role="alert">{t('当前版本未注册此插件页面。')}</p>
              : route.pluginId ? !plugin || !visibleDetail ? <p role="alert">{t('当前没有可访问的插件。')}</p>
                : pageId !== 'overview' ? selected && installed && availability?.available
                  ? <PluginContentBoundary key={[plugin.id, selected.id, row?.revision, row?.version, session.user.accountId, session.csrfToken].join(':')}
                    plugin={plugin} page={selected} section={selected.id} session={session} revision={row?.revision} version={row?.version} />
                  : <p role="alert">{t(!installed || !availability?.available ? pluginAvailabilityMessage(availability?.reason || 'not_installed') : '你没有访问此插件页面的权限。')}</p>
                  : <SettingsSection title={metadataText(plugin, 'name')}>
                    <div className="space-y-3 text-sm leading-relaxed text-[var(--muted)]">
                      <p>{metadataText(plugin, 'description')}</p>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2">
                        <dt>{t('版本')}</dt><dd>{plugin.version}</dd>
                        <dt>{t('宿主 API')}</dt><dd>{'v' + plugin.hostApiVersion}</dd>
                        <dt>{t('内部标识')}</dt><dd className="break-all">{plugin.id}</dd>
                        <dt>{t('支持语言')}</dt><dd>{plugin.supportedLocales?.map(id => UI_LANGUAGES.find(language => language.id === id)?.name || id).join('、') || t('未声明')}</dd>
                        <dt>{t('来源')}</dt><dd className="min-w-0 break-all">{deliveryRow?.sourceId && deliveryRow.sourceId !== 'workspace' ? deliveryRow.sourceName : t('当前部署')}
                          {deliveryRow?.sourceId && deliveryRow.sourceId !== 'workspace' && <p className="mt-1 text-xs">{delivery.data?.sources.find(source => source.id === deliveryRow.sourceId)?.url || deliveryRow.source.url}</p>}</dd>
                      </dl>
                      <p>{t(installed ? '已安装' : '未安装')}</p>
                      {plugin.localization?.fallback && <p role="status">{t('此插件暂不支持当前界面语言，已使用默认语言。')}</p>}
                      <PluginAvailability plugin={plugin} availability={availability} />
                    </div>
                    {(installed || isAdmin) && <SettingsActions className="mt-4">
                      {installed && links(plugin, availability)}
                      {isAdmin && installed && availability?.reason === 'data_migration_required' && <SettingsButton variant="primary" disabled={resource.busy || !row} onClick={() => setConfirm('upgrade')}>{t('完成插件更新')}</SettingsButton>}
                      {isAdmin && <SettingsButton variant={installed ? 'danger' : 'primary'} disabled={resource.busy || delivery.busy || !delivery.data || activePluginBuild(delivery.data?.build) || delivery.data?.build?.resultUnknown} onClick={() => setConfirm(installed ? 'uninstall' : 'install')}>{t(installed ? '卸载插件' : '安装插件')}</SettingsButton>}
                    </SettingsActions>}
                    {isAdmin && !!delivery.data?.pending.length && <div className="mt-5"><PluginDeliveryStatus delivery={delivery} /></div>}
                  </SettingsSection>
                : <div className="space-y-4">
                  {entries.map(entry => {
                    const item = localizePlugin(getPlugin(entry.id), locale), state = availabilityFor(entry.id);
                    return <SettingsSection key={entry.id} title={metadataText(item, 'name')}
                      meta={`${t(entry.installed ? '已安装' : '未安装')} · ${entry.version}`}
                      description={metadataText(item, 'description')}
                      action={<SettingsActions>
                        {entry.installed && links(item, state)}
                        <PluginLink route={detailRoute(entry.id)}>{t('查看插件')}</PluginLink>
                      </SettingsActions>}>
                      {entry.installed && <PluginAvailability plugin={item} availability={state} />}
                    </SettingsSection>;
                  })}
                  {entries.length === 0 && <p role="status" className="text-sm text-[var(--muted)]">{t('暂无对当前身份开放的已安装插件。')}</p>}
                </div>}
    {resource.loaded && resource.error && <div role="alert" className="space-y-3 text-sm text-red-600 dark:text-red-400"><p>{t(resource.error)}</p></div>}
    {confirm && plugin && <PluginConfirmDialog installed={installed} operation={confirm} deferred={confirm !== 'upgrade'} deliveryMode={delivery.data?.settings.mode}
      busy={resource.busy || delivery.busy} error={delivery.error || resource.error} onClose={() => setConfirm(false)} onConfirm={save} />}
  </div>;
}
