export const SHELL_THEME = {
  id: 'fluid',
  modes: {
    light: {
      page: '#ffffff',
      surface: '#f4f4f5',
      'surface-raised': '#ffffff',
      ink: '#18181b',
      muted: '#52525b',
      faint: '#595962',
      line: 'rgba(0, 0, 0, 0.08)',
      'soft-line': 'rgba(0, 0, 0, 0.04)',
      accent: '#0284c7',
      'accent-strong': '#0369a1',
      swatch: '#0284c7',
      danger: '#dc2626',
      'player-bg': 'rgba(255, 255, 255, 0.04)',
      'player-line': 'rgba(0, 0, 0, 0.08)',
      'player-shadow': '0 12px 32px -4px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04)',
      'drawer-bg': '#fafafa',
      'drawer-line': 'rgba(255, 255, 255, 0.60)',
      'drawer-shadow': '-16px 0 48px -4px rgba(0, 0, 0, 0.10)',
    },
    dark: {
      page: '#09090b',
      surface: '#18181b',
      'surface-raised': '#27272a',
      ink: '#fafafa',
      muted: '#d4d4d8',
      faint: '#a1a1aa',
      line: 'rgba(255, 255, 255, 0.10)',
      'soft-line': 'rgba(255, 255, 255, 0.05)',
      accent: '#38bdf8',
      'accent-strong': '#7dd3fc',
      swatch: '#38bdf8',
      danger: '#f87171',
      'player-bg': 'rgba(255, 255, 255, 0.04)',
      'player-line': 'rgba(255, 255, 255, 0.12)',
      'player-shadow': '0 16px 40px -6px rgba(0, 0, 0, 0.50), 0 4px 16px rgba(0, 0, 0, 0.30)',
      'drawer-bg': '#18181b',
      'drawer-line': 'rgba(255, 255, 255, 0.10)',
      'drawer-shadow': '-24px 0 56px -8px rgba(0, 0, 0, 0.60)',
    },
  },
};

export const getShellThemeStyle = (theme = SHELL_THEME, isDark) => {
  const targetTheme = theme || SHELL_THEME;
  const mode = targetTheme.modes[isDark ? 'dark' : 'light'];
  return {
    ...Object.fromEntries(
      Object.entries(mode).map(([name, value]) => [`--${name}`, value]),
    ),
    ...Object.fromEntries(
      Object.entries(targetTheme.modes.dark).map(([name, value]) => [`--${name}-dark`, value]),
    ),
  };
};
