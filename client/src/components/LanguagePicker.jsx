import React from 'react';
import { UI_LANGUAGES } from '../../../shared/uiLanguages.js';
import { getUiLanguage, setUiLanguage, t, useLocale, useLanguageLoadState } from '../i18n/index.js';

export default function LanguagePicker({ onChange = setUiLanguage }) {
  useLocale();
  const state = useLanguageLoadState();
  return <div className="flex flex-wrap items-center gap-2 text-sm">
    <label className="inline-flex min-h-11 items-center gap-2">
      <span>{t('界面语言')}</span>
      <select className="min-h-11 max-w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2"
        value={getUiLanguage()} onChange={event => void onChange(event.target.value)} aria-busy={state.loading}>
        <option value="auto">{t('跟随浏览器')}</option>
        {UI_LANGUAGES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    {state.loading && <span role="status">{t('正在加载…')}</span>}
    {state.error && <span role="alert">{t(state.error)} <button type="button" className="app-section-link"
      onClick={() => void onChange(getUiLanguage())}>{t('重试')}</button></span>}
  </div>;
}
