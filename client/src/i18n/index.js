import { useSyncExternalStore } from 'react';
import english from './en.js';

const listeners = new Set();
let preference = 'auto';
let currentLocale = 'en';

export function browserLocale(navigatorLike = globalThis.navigator) {
  const first = navigatorLike?.languages?.[0] || navigatorLike?.language || '';
  return /^zh(?:-|$)/i.test(first) ? 'zh' : 'en';
}

export function resolveLocale(uiLanguage, navigatorLike = globalThis.navigator) {
  return uiLanguage === 'zh' || uiLanguage === 'en' ? uiLanguage : browserLocale(navigatorLike);
}

function updateDocumentLanguage() {
  if (globalThis.document?.documentElement) {
    document.documentElement.lang = currentLocale === 'zh' ? 'zh-CN' : 'en';
    const description = currentLocale === 'zh'
      ? 'FlareTune 是面向个人和家庭的自建音频流媒体应用。'
      : 'FlareTune is a self-hosted audio streaming app for individuals and families.';
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
      document.querySelector?.(selector)?.setAttribute('content', description);
    }
    document.querySelector?.('meta[property="og:locale"]')?.setAttribute('content', currentLocale === 'zh' ? 'zh_CN' : 'en_US');
  }
}

export function setUiLanguage(uiLanguage) {
  preference = ['auto', 'zh', 'en'].includes(uiLanguage) ? uiLanguage : 'auto';
  const next = resolveLocale(preference);
  if (next !== currentLocale) {
    currentLocale = next;
    updateDocumentLanguage();
    for (const listener of listeners) listener();
  } else updateDocumentLanguage();
}

export function getLocale() { return currentLocale; }
export function getUiLanguage() { return preference; }
export function useLocale() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getLocale, () => 'en');
}

export function t(source, values) {
  const pattern = currentLocale === 'en' ? english[source] || source : source;
  return values ? pattern.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match) : pattern;
}

export function localizeUnknownArtist(artist) {
  return artist && artist !== '未知艺术家' ? artist : t('未知艺术家');
}

setUiLanguage('auto');
