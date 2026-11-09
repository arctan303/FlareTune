import React from 'react';
import { t } from '../i18n/index.js';
import SettingsSkeleton from './SettingsSkeleton.jsx';
import { SettingsButton } from './SettingsControls.jsx';
import { createPluginHost } from '../plugins/host.js';

const contents = new Map();
export function PluginContentSession({ Content, plugin, page, section, session, context }) {
  const [scope] = React.useState(() => {
    const controller = new AbortController();
    return { controller, host: createPluginHost(plugin, { signal: controller.signal, route: context?.route }) };
  });
  React.useEffect(() => () => scope.controller.abort(), [scope]);
  return <Content host={scope.host} page={page} pageId={page?.id || section} section={section} context={context} />;
}
export default class PluginContentBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    const { plugin, page, section, session, revision, version, context } = this.props;
    if (this.state.failed) return <div role="alert" className="space-y-3 text-sm text-[var(--muted)]">
      <p>{t('插件内容加载失败，请重试。')}</p>
      <SettingsButton onClick={() => { contents.delete(plugin.id); this.setState({ failed: false }); }}>{t('重试')}</SettingsButton>
    </div>;
    if (!contents.has(plugin.id)) contents.set(plugin.id, React.lazy(plugin.loadContent));
    const Content = contents.get(plugin.id);
    return <React.Suspense fallback={<SettingsSkeleton cards={1} rows={2} />}><PluginContentSession
      key={`${plugin.id}:${revision}:${version}:${page?.group || page?.id || section}:${context?.route?.songId || ''}:${session?.user?.accountId}:${session?.csrfToken}`}
      Content={Content} plugin={plugin} page={page} section={section} session={session} context={context} /></React.Suspense>;
  }
}
