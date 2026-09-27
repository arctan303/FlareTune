/**
 * 门禁层主题：登录、初始化、维护、恢复和强制改密页运行在应用壳层之外，
 * 没有 hooks/useTheme.js 负责写入外壳令牌，所以必须自己应用一次。
 * 令牌值仍以 constants/shellThemes.js 为唯一来源，偏好读写复用 utils/themePreference.js，
 * 使门禁与登录后的应用保持同一套明暗外观。
 */
import React from 'react';
import { SHELL_THEME } from '../constants/shellThemes.js';
import { readThemePreference, resolveDarkAppearance } from '../utils/themePreference.js';

export const INSTANCE_DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveInstanceDarkMode(
  storage = globalThis.localStorage,
  media = globalThis.window?.matchMedia?.(INSTANCE_DARK_QUERY),
) {
  return resolveDarkAppearance(readThemePreference(storage), Boolean(media?.matches));
}

/** 写入外壳令牌；与 hooks/useTheme.js 的 applyTheme 保持一致的应用结果。 */
export function applyInstanceTheme(isDark, root = globalThis.document?.documentElement) {
  if (!root) return null;
  const mode = SHELL_THEME.modes[isDark ? 'dark' : 'light'];
  root.classList.toggle('dark', isDark);
  root.style.colorScheme = isDark ? 'dark' : 'light';
  root.dataset.shellTheme = SHELL_THEME.id;
  Object.entries(mode).forEach(([name, value]) => root.style.setProperty(`--${name}`, value));
  const meta = globalThis.document?.getElementById?.('theme-color-meta');
  if (meta) meta.setAttribute('content', mode.page);
  return mode;
}

export function useInstanceTheme() {
  const [isDark, setIsDark] = React.useState(() => resolveInstanceDarkMode());
  React.useLayoutEffect(() => {
    applyInstanceTheme(isDark);
  }, [isDark]);
  React.useEffect(() => {
    const media = window.matchMedia(INSTANCE_DARK_QUERY);
    const onChange = (event) => {
      if (readThemePreference(window.localStorage) === 'system') setIsDark(event.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return isDark;
}
