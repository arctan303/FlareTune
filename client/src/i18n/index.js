import { useSyncExternalStore } from 'react';
import english from './en.js';
import { isUiLanguage, languageTag, matchUiLanguage } from '../../../shared/uiLanguages.js';

const listeners = new Set();
let preference = 'auto', currentLocale = 'en', generation = 0;
const dictionaries = new Map([['zh', null], ['en', english]]);
const pending = new Map();
let loadState = { loading: false, error: null, requested: 'en' };
const loaders = {
  'zh-Hant': () => import('./locales/zh-Hant.js'), ja: () => import('./locales/ja.js'),
  ko: () => import('./locales/ko.js'), es: () => import('./locales/es.js'),
  fr: () => import('./locales/fr.js'), de: () => import('./locales/de.js'),
  'pt-BR': () => import('./locales/pt-BR.js'),
};
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };

export function browserLocale(navigatorLike = globalThis.navigator) {
  const candidates = navigatorLike?.languages?.length ? navigatorLike.languages : [navigatorLike?.language];
  return candidates.map(matchUiLanguage).find(Boolean) || 'en';
}

export function resolveLocale(uiLanguage, navigatorLike = globalThis.navigator) {
  return uiLanguage !== 'auto' && isUiLanguage(uiLanguage) ? uiLanguage : browserLocale(navigatorLike);
}

function updateDocumentLanguage() {
  if (globalThis.document?.documentElement) {
    document.documentElement.lang = languageTag(currentLocale);
    const description = t('无需VPS，使用Cloudflare建立自己的私人音乐库。');
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
      document.querySelector?.(selector)?.setAttribute('content', description);
    }
    document.querySelector?.('meta[property="og:locale"]')?.setAttribute('content', languageTag(currentLocale).replaceAll('-', '_'));
  }
}

export async function setUiLanguage(uiLanguage, { load = (locale) => loaders[locale]() } = {}) {
  preference = isUiLanguage(uiLanguage) ? uiLanguage : 'auto';
  const next = resolveLocale(preference), token = ++generation;
  if (!dictionaries.has(next)) {
    loadState = { loading: true, error: null, requested: next }; notify();
    try {
      if (!pending.has(next)) pending.set(next, Promise.resolve().then(() => load(next)));
      const module = await pending.get(next);
      dictionaries.set(next, module.default || module);
      pending.delete(next);
    } catch {
      pending.delete(next);
      if (token === generation) {
        loadState = { loading: false, error: '语言资源加载失败，请重试。', requested: next }; notify();
      }
      return false;
    }
  }
  if (token !== generation) return false;
  currentLocale = next;
  loadState = { loading: false, error: null, requested: next };
  updateDocumentLanguage(); notify();
  return true;
}

export function getLocale() { return currentLocale; }
export function getUiLanguage() { return preference; }
export function useLocale() {
  return useSyncExternalStore(subscribe, getLocale, () => 'en');
}
export function useLanguageLoadState() { return useSyncExternalStore(subscribe, () => loadState, () => loadState); }

export function t(source, values) {
  let pattern = currentLocale === 'zh' ? source : dictionaries.get(currentLocale)?.[source] || english[source] || source;
  if (pattern && typeof pattern === 'object') {
    pattern = pattern[new Intl.PluralRules(languageTag(currentLocale)).select(Number(values?.count ?? values?.p0 ?? 0))] || pattern.other;
  }
  if (typeof pattern !== 'string') pattern = source;
  return values ? pattern.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match) : pattern;
}

export function localizeUnknownArtist(artist) {
  return artist && artist !== '未知艺术家' ? artist : t('未知艺术家');
}

export const formatNumber = (number, options) => new Intl.NumberFormat(languageTag(currentLocale), options).format(number);
export const formatDateTime = (date, options) => new Intl.DateTimeFormat(languageTag(currentLocale), options).format(date);
export const formatRelative = (value, unit) => new Intl.RelativeTimeFormat(languageTag(currentLocale), { numeric: 'auto' }).format(value, unit);
export const languageReady = setUiLanguage('auto');
