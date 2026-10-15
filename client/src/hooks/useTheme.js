import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createResilientStorage } from '../utils/browserStorage.js';
import {
  SHELL_THEME,
} from '../constants/shellThemes';
import { useUIStore } from '../store/useUIStore';
import { readThemePreference, resolveDarkAppearance, THEME_PREFERENCES, writeThemePreference } from '../utils/themePreference.js';
import {
  VISUAL_MOTION_PHASE,
} from '../utils/motionPerformance';

const THEME_TRANSITION_MS = 360;
const themeStorage = createResilientStorage();

function applyTheme(themeMode) {
  const root = document.documentElement;
  const meta = document.getElementById('theme-color-meta');
  const isDark = themeMode === 'dark';
  const colors = SHELL_THEME.modes[isDark ? 'dark' : 'light'];
  root.classList.toggle('dark', isDark);
  root.style.colorScheme = isDark ? 'dark' : 'light';
  root.dataset.shellTheme = SHELL_THEME.id;
  Object.entries(colors).forEach(([name, value]) => {
    root.style.setProperty(`--${name}`, value);
  });
  if (meta) meta.setAttribute('content', colors.page);
}

export function useTheme(
  isDark,
  setIsDark,
) {
  const transitionTimerRef = useRef(null);
  const [themePreference, setThemePreferenceState] = useState('system');

  const selectTheme = (mode) => {
    if (!THEME_PREFERENCES.has(mode)) return;
    const isDarkMode = resolveDarkAppearance(mode, window.matchMedia('(prefers-color-scheme: dark)').matches);
    writeThemePreference(themeStorage, mode);
    setThemePreferenceState(mode);
    setIsDark(isDarkMode);
  };

  useLayoutEffect(() => {
    applyTheme(isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => () => {
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }
    useUIStore.getState().setVisualMotionPhase((current) => (
      current === VISUAL_MOTION_PHASE.THEME
        ? VISUAL_MOTION_PHASE.IDLE
        : current
    ));
  }, []);

  useEffect(() => {
    const preference = readThemePreference(themeStorage);
    setThemePreferenceState(preference);
    setIsDark(resolveDarkAppearance(preference, window.matchMedia('(prefers-color-scheme: dark)').matches));
  }, [setIsDark]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event) => {
      if (themePreference === 'system') setIsDark(event.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [setIsDark, themePreference]);

  const toggleTheme = () => {
    const nextIsDark = !document.documentElement.classList.contains('dark');
    const nextMode = nextIsDark ? 'dark' : 'light';
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }

    useUIStore.getState().setVisualMotionPhase(VISUAL_MOTION_PHASE.THEME);

    applyTheme(nextMode);
    selectTheme(nextMode);

    transitionTimerRef.current = window.setTimeout(() => {
      transitionTimerRef.current = null;
      useUIStore.getState().setVisualMotionPhase((current) => (
        current === VISUAL_MOTION_PHASE.THEME
          ? VISUAL_MOTION_PHASE.IDLE
          : current
      ));
    }, THEME_TRANSITION_MS);
  };

  return {
    toggleTheme,
    themePreference,
    selectTheme,
    shellThemeId: SHELL_THEME.id,
    activeShellTheme: SHELL_THEME,
  };
}
