import React from 'react';
import AccountSettings from '../client/src/components/AccountSettings.jsx?demo-original';
import { withDemoSettings } from './ReadOnlySurface.jsx';
import SettingsSection from '../client/src/components/SettingsSection.jsx';
import { SettingsActions, SettingsButton } from '../client/src/components/SettingsControls.jsx';
import { t, useLocale } from '../client/src/i18n/index.js';
import { demoData } from './transport.js';
const DemoAccount = withDemoSettings(AccountSettings);
export default function DemoAccountSettings() {
  useLocale();
  const temporary = React.useSyncExternalStore(demoData.subscribe, demoData.isTemporary, () => false);
  const openPanel = panel => window.dispatchEvent(new CustomEvent('flaretune-demo:panel', { detail: panel }));
  return <div className="space-y-6 sm:space-y-7">
    <DemoAccount />
    <SettingsSection title={t('素材与体验边界')}>
      <p className="text-sm text-[var(--muted)]">{t('演示数据仅保存在当前浏览器，不需要登录。')}</p>
      {temporary && <p className="mt-2 text-sm text-[var(--muted)]" role="status">{t('浏览器存储不可用，本次体验的数据仅临时保留。')}</p>}
      <SettingsActions className="mt-4">
        <SettingsButton onClick={() => openPanel('sources')}>{t('素材与体验边界')}</SettingsButton>
        <SettingsButton onClick={() => openPanel('reset')}>{t('重置演示数据')}</SettingsButton>
      </SettingsActions>
    </SettingsSection>
  </div>;
}
