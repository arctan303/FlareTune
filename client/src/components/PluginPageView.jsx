import React from 'react';
import { t, useLocale } from '../i18n/index.js';
import { usePlugins } from '../hooks/usePlugins.js';
import { getPlugin, getPluginPage, getPluginAvailability, getPrimaryPluginSettingsPageId, canAccessPluginDeclaration, localizePlugin } from '../plugins/registry.js';
import PluginSettingsView, { pluginAvailabilityMessage } from './PluginSettingsView.jsx';
import PluginContentBoundary from './PluginContentBoundary.jsx';
import SettingsSkeleton from './SettingsSkeleton.jsx';
import { SettingsButton } from './SettingsControls.jsx';

export function resolvePluginPageAccess({ plugin, page, session, loaded, availability }) {
  if (!session?.authenticated) return 'authentication';
  if (!plugin || !page) return 'missing';
  if (!canAccessPluginDeclaration(page, session.user?.role)) return 'permission';
  if (!loaded) return 'loading';
  if (page.id !== 'overview' && !availability?.available) return availability?.reason || 'unavailable';
  return null;
}

export default function PluginPageView({ route, session }) {
  const locale = useLocale();
  const resource = usePlugins(session);
  const plugin = localizePlugin(getPlugin(route?.pluginId), locale), page = getPluginPage(plugin, route?.pluginPage || 'overview');
  const availability = plugin ? getPluginAvailability(plugin.id, { installedIds: resource.installedIds,
    availabilityById: resource.availabilityById }) : null;
  const row = resource.plugins.find(entry => entry.id === plugin?.id);
  const denied = resolvePluginPageAccess({ plugin, page, session, loaded: resource.loaded, availability });
  const pageTitle = page?.id === getPrimaryPluginSettingsPageId(plugin) ? t('设置')
    : page?.labelKey ? page.label : t(page?.label || '插件');
  const pluginName = plugin && (plugin.supportedLocales?.length ? plugin.name : t(plugin.name));
  const workspace = page?.presentation === 'workspace';
  if (!route?.pluginId || route.pluginPage === 'overview' || !route.pluginPage) return <PluginSettingsView route={route} session={session} />;
  return <div className={workspace ? 'h-full min-h-0 w-full flex flex-col' : 'app-page mx-auto w-full max-w-4xl space-y-5 pb-28'}>
    <header className={workspace ? 'sr-only' : 'flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--line)] pb-4'}>
      <h1 className="text-xl font-bold tracking-tight text-[var(--ink)] sm:text-2xl">{pageTitle}</h1>
      {pluginName && pluginName !== pageTitle && <span className="text-xs font-medium text-[var(--muted)]">{pluginName}</span>}
    </header>
    {resource.demo ? <p role="status">{t('演示模式无法安装或管理插件。')}</p>
      : denied === 'loading' ? resource.error ? <div className="space-y-3"><p role="alert">{t(resource.error)}</p>
        <SettingsButton onClick={() => { void resource.refresh().catch(() => {}); }}>{t('重试')}</SettingsButton></div>
        : <SettingsSkeleton cards={1} rows={2} />
        : denied ? <p role="alert" className="text-sm text-[var(--muted)]">{t(denied === 'authentication' ? '请先登录后使用插件。'
          : denied === 'permission' ? '你没有访问此插件页面的权限。' : denied === 'missing' ? '当前版本未注册此插件页面。' : pluginAvailabilityMessage(denied))}</p>
          : <PluginContentBoundary key={`${plugin.id}:${page.group || page.id}:${row?.revision}:${row?.version}:${session.user.accountId}:${session.csrfToken}`}
            plugin={plugin} page={page} section={page.id} session={session} revision={row?.revision} version={row?.version}
            context={{ route, playerPlacement: page.playerPlacement || 'inherit' }} />}
  </div>;
}
