import React from 'react';
import { SettingsReadOnlyContext } from '../client/src/components/SettingsReadOnly.jsx';
import { t, useLocale } from '../client/src/i18n/index.js';

export function withDemoSettings(Component) {
  return function DemoSettings(props) {
    useLocale();
    return <SettingsReadOnlyContext.Provider value={true}>
      <p className="mb-4 text-sm text-[var(--muted)]" role="status">{t('演示模式下，管理配置仅供查看；本地偏好可以修改。')}</p>
      <Component {...props} />
    </SettingsReadOnlyContext.Provider>;
  };
}
