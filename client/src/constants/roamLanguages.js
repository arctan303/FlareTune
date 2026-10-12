import { getLocale, t } from '../i18n/index.js';
import { getLanguageLabel } from './language.js';

export const ROAM_LANGUAGES = Object.freeze([
    { key: 'zh', label: '中文' },
    { key: 'en', label: '英语' },
    { key: 'ja', label: '日语' },
    { key: 'ko', label: '韩语' },
    { key: 'instrumental', label: '纯音乐' },
    { key: 'other', label: '其他语言' },
]);

export function formatRoamLanguageScope(language = 'all') {
    if (language === 'all') return t('全曲库');
    const keys = [...new Set(language.split(',').map(key => key.trim()).filter(Boolean))];
    const labels = keys.map(key => getLanguageLabel(key));
    return labels.length ? new Intl.ListFormat(getLocale(), { style: 'short', type: 'conjunction' }).format(labels) : t('已选语种');
}
