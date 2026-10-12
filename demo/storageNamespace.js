// Only the independent Vite build applies these names. Never patch browser APIs.
export const DEMO_STORAGE_PREFIX = 'flaretune-demo:v1:';
export const DEMO_DATABASES = ['flaretune-demo:v1:arc-player-context','flaretune-demo:v1:music_wallpaper_db'];
export function namespaceDemoStorage(code) {
  return code.replace(/(['"])((?:musicPlayer_|music-play-|arc_recent_)[^'"\n]*|theme_pref|arc-player-context|music_wallpaper_db)\1/g,
    (_, quote, key) => `${quote}${DEMO_STORAGE_PREFIX}${key}${quote}`);
}
