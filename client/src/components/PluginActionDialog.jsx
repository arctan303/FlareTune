import React from 'react';
import { t } from '../i18n/index.js';
import { useUIStore } from '../store/useUIStore.js';
import { usePluginStore } from '../store/usePluginStore.js';
import { pluginBindings } from '../plugins/compiled.js';
import { createPluginHost } from '../plugins/host.js';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import { SettingsButton } from './SettingsControls.jsx';

const loaders = new Map();
class ActionBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <SettingsEditDialog title={this.props.title} onClose={this.props.onClose} size="small">
      <p role="alert" className="text-sm text-[var(--muted)]">{t('插件内容加载失败，请重试。')}</p>
      <SettingsButton onClick={() => { this.props.retry(); this.setState({ failed: false }); }}>{t('重试')}</SettingsButton>
    </SettingsEditDialog>;
    return this.props.children;
  }
}
export default function PluginActionDialog({ selection, onClose }) {
  const { entry, session: owner, context, revision } = selection;
  const session = useUIStore(state => state.authSession);
  const state = usePluginStore();
  const [attempt, setAttempt] = React.useState(0);
  const [controller] = React.useState(() => new AbortController());
  const current = session?.authenticated && session.user?.accountId === owner.user?.accountId
    && session.csrfToken === owner.csrfToken && state.loaded && state.installedIds.includes(entry.pluginId)
    && state.plugins.find(row => row.id === entry.pluginId)?.revision === revision
    && state.availabilityById?.[entry.pluginId]?.available !== false
    && state.plugins.find(row => row.id === entry.pluginId)?.availability?.available !== false;
  React.useEffect(() => () => controller.abort(), [controller]);
  React.useEffect(() => { if (!current) { controller.abort(); onClose(); } }, [current, controller, onClose]);
  const host = React.useMemo(() => createPluginHost(entry.plugin, { signal: controller.signal }), [entry.plugin, controller]);
  const key = `${entry.pluginId}:${entry.action}:${attempt}`;
  if (!current) return null;
  const binding = pluginBindings[entry.pluginId];
  if (!binding?.actions.includes(entry.action)) return null;
  if (!loaders.has(key)) loaders.set(key, React.lazy(binding.loadAction));
  const Content = loaders.get(key);
  const title = entry.labelKey ? entry.label : t(entry.label);
  return <ActionBoundary title={title} onClose={onClose} retry={() => { loaders.delete(key); setAttempt(value => value + 1); }}>
    <React.Suspense fallback={<SettingsEditDialog title={title} onClose={onClose} size="small"><p role="status">{t('正在加载…')}</p></SettingsEditDialog>}>
      <Content action={entry.action} host={host} context={context} onClose={onClose} />
    </React.Suspense>
  </ActionBoundary>;
}
