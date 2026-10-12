import React from 'react';
import LanguagePicker from '../client/src/components/LanguagePicker.jsx';
import SettingsSection from '../client/src/components/SettingsSection.jsx';
import { setUiLanguage, t } from '../client/src/i18n/index.js';
import { runtimeFetch } from './transport.js';
export default function DemoAccountSettings() {
  const change = async (value) => {
    await runtimeFetch('/api/account/ui-language', { method: 'PATCH', body: JSON.stringify({ uiLanguage: value }) });
    await setUiLanguage(value);
  };
  return <SettingsSection title={t('界面语言')}>
    <LanguagePicker onChange={change} />
    <p className="mt-4 text-sm text-[var(--muted)]">{t('演示数据仅保存在当前浏览器，不需要登录。')}</p>
  </SettingsSection>;
}
