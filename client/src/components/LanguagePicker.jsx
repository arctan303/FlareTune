import React from 'react';
import { UI_LANGUAGES } from '../../../shared/uiLanguages.js';
import { getUiLanguage, setUiLanguage, t, useLocale, useLanguageLoadState } from '../i18n/index.js';
import SelectControl from './SelectControl.jsx';

export default function LanguagePicker({ onChange = setUiLanguage, disabled = false, showLabel = true }) {
  useLocale();
  const state = useLanguageLoadState();
  return <div className="flex flex-wrap items-center gap-2 text-sm" aria-busy={state.loading}>
    <div className="inline-flex min-h-11 min-w-0 items-center gap-2">
      {showLabel && <span>{t('界面语言')}</span>}
      <SelectControl className="min-h-11 max-w-full" aria-label={t('界面语言')} allowInReadOnly disabled={disabled}
        value={getUiLanguage()} onChange={event => void onChange(event.target.value)}>
        <option value="auto">{t('跟随浏览器')}</option>
        {UI_LANGUAGES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </SelectControl>
    </div>
    {state.loading && <span role="status">{t('正在加载…')}</span>}
    {state.error && <span role="alert">{t(state.error)} <button type="button" className="app-section-link"
      onClick={() => void onChange(getUiLanguage())}>{t('重试')}</button></span>}
  </div>;
}
