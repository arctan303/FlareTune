export const IMMERSIVE_THEMES = [
    {
        id: 'artist-photo',
        name: '歌手写真',
        overlay: 'from-black/55 via-black/20 to-black/70',
        defaultSettings: {
            glassMaterial: 'glass-invisible',
            accentColor: '#10b981',
            fontFamily: 'font-serif',
            lyricTransition: 'random',
            lyricShadow: 'heavy',
            ambientIntensity: 'standard'
        }
    },
];

export const getImmersiveTheme = (themeId) =>
    IMMERSIVE_THEMES.find((theme) => theme.id === themeId) || IMMERSIVE_THEMES[0];
