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

export function localizeLibraryPlaylist(playlist, info) {
    if (!playlist || (playlist.type !== 'library' && !playlist.id?.startsWith('lang-'))) return { playlist, info };
    const label = getLanguageLabel(playlist.langKey || playlist.id.replace('lang-', ''));
    return {
        playlist: { ...playlist, name: t('{p0}歌曲', { p0: label }) },
        info: { ...info, creator: t('官方曲库'),
            createdAt: t((playlist.pagination?.sort || playlist.sort || 'desc') === 'desc' ? '按最新收录' : '按最早收录'),
            description: t('全库共收录 {p0} 首{p1}歌曲 · 支持新旧排序与单曲收听', { p0: playlist.pagination?.total ?? 0, p1: label }) },
    };
}
