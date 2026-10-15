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

/**
 * 根据用户当前 UI 语言推导匹配的专属漫游语种 (若无对应专属分类则返回 null)
 */
export function getMatchingRoamLanguageKey(locale) {
    if (!locale || typeof locale !== 'string') return null;
    const base = locale.toLowerCase().split('-')[0];
    if (base === 'zh') return 'zh';
    if (base === 'en') return 'en';
    if (base === 'ja') return 'ja';
    if (base === 'ko') return 'ko';
    return null;
}

export function getRoamShortcutLabel(roamKey) {
    if (!roamKey) return null;
    if (roamKey === 'zh') return t('仅中文');
    if (roamKey === 'en') return t('仅英语');
    if (roamKey === 'ja') return t('仅日语');
    if (roamKey === 'ko') return t('仅韩语');
    return t('仅{p0}', { p0: getLanguageLabel(roamKey) });
}

export function getRoamShortcutToast(roamKey) {
    if (!roamKey) return t('已更新漫游语种偏好');
    if (roamKey === 'zh') return t('已切换为仅中文漫游');
    if (roamKey === 'en') return t('已切换为仅英语漫游');
    if (roamKey === 'ja') return t('已切换为仅日语漫游');
    if (roamKey === 'ko') return t('已切换为仅韩语漫游');
    return t('已切换为仅{p0}漫游', { p0: getLanguageLabel(roamKey) });
}
