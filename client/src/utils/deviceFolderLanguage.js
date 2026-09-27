import { suggestSongLanguage } from './songLanguageSuggestion.js';

const FOLDER_CODES = Object.freeze({
  zh: 'zh', en: 'en', ja: 'ja', jp: 'ja', jn: 'ja', ko: 'ko', yue: 'yue',
  instrumental: 'instrumental', '纯音乐': 'instrumental',
});

// The agent reports paths as "configured root / relative path". Group songs by
// the first directory below that root, or by the root when files are direct children.
export function deviceFolder(path = '') {
  const parts = String(path).replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0] || '未分类';
}

export function resolveDeviceLanguage(file, mappings = {}) {
  const folder = deviceFolder(file.path);
  const choice = mappings[folder] || 'folder';
  if (choice !== 'folder' && choice !== 'auto') {
    return { code: choice, source: 'folder', reason: `目录 ${folder} 人工映射` };
  }
  if (choice === 'folder') {
    const parts = folder.toLocaleLowerCase().split('/');
    const code = FOLDER_CODES[parts.at(-1)] || FOLDER_CODES[parts[0]];
    if (code) return { code, source: 'folder', reason: `目录 ${folder} 自动映射` };
  }
  return suggestSongLanguage(file.common || {});
}
