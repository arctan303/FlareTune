// Persisted values shared by the browser and account preference endpoint.
export const UI_LANGUAGES = Object.freeze([
  { id: 'zh', name: '简体中文', tag: 'zh-CN' },
  { id: 'en', name: 'English', tag: 'en' },
  { id: 'zh-Hant', name: '繁體中文', tag: 'zh-Hant' },
  { id: 'ja', name: '日本語', tag: 'ja' },
  { id: 'ko', name: '한국어', tag: 'ko' },
  { id: 'es', name: 'Español', tag: 'es' },
  { id: 'fr', name: 'Français', tag: 'fr' },
  { id: 'de', name: 'Deutsch', tag: 'de' },
  { id: 'pt-BR', name: 'Português (Brasil)', tag: 'pt-BR' },
]);
export const isUiLanguage = (value) => value === 'auto' || UI_LANGUAGES.some(item => item.id === value);
export const languageTag = (value) => UI_LANGUAGES.find(item => item.id === value)?.tag || 'en';
export function matchUiLanguage(value) {
  if (typeof value !== 'string') return null;
  const parts = value.toLowerCase().replaceAll('_', '-').split('-');
  if (parts[0] === 'zh') {
    if (parts.includes('hant')) return 'zh-Hant';
    if (parts.includes('hans')) return 'zh';
    return parts.some(part => ['tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh';
  }
  if (parts[0] === 'pt') return 'pt-BR';
  return UI_LANGUAGES.find(item => item.id === parts[0])?.id || null;
}
