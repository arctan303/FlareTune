export const THEME_STORAGE_KEY = 'theme_pref';
export const THEME_PREFERENCES = new Set(['system', 'light', 'dark']);

export function readThemePreference(storage, now = Date.now()) {
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    if (!raw) return 'system';
    const parsed = JSON.parse(raw);
    if (THEME_PREFERENCES.has(parsed?.value) && (!parsed.expires || parsed.expires > now)) return parsed.value;
    storage.removeItem(THEME_STORAGE_KEY);
  } catch {
    try { storage.removeItem(THEME_STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
  }
  return 'system';
}

export function writeThemePreference(storage, mode) {
  if (!THEME_PREFERENCES.has(mode)) return false;
  try {
    if (mode === 'system') storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, JSON.stringify({ value: mode }));
    return true;
  } catch {
    return false;
  }
}

export const resolveDarkAppearance = (mode, systemDark) => mode === 'dark' || (mode === 'system' && systemDark);
