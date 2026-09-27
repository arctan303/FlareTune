import { create } from 'zustand';

export const useThemeStore = create((set) => ({
    showDebugger: false,
    setShowDebugger: (val) => set({ showDebugger: val }),

    glassMaterial: 'glass-light', // glass-light, glass-dark, invisible
    setGlassMaterial: (val) => set({ glassMaterial: val }),

    accentColor: '#3b82f6', // blue, green, orange, white
    setAccentColor: (val) => set({ accentColor: val }),

    fontFamily: 'font-sans', // font-sans, font-serif, font-mono
    setFontFamily: (val) => set({ fontFamily: val }),

    lyricTransition: 'random', // drift, blur-focus, spring, breathe, wind, dew, rain, firefly, random
    setLyricTransition: (val) => set({ lyricTransition: val }),

    // When lyricTransition === 'random', this holds the actual resolved effect id
    resolvedTransition: 'drift',
    setResolvedTransition: (val) => set({ resolvedTransition: val }),

    lyricShadow: 'heavy', // heavy, light, none
    setLyricShadow: (val) => set({ lyricShadow: val }),

    // Helper to get all current config
    exportConfig: () => {
        const state = useThemeStore.getState();
        return JSON.stringify({
            glassMaterial: state.glassMaterial,
            accentColor: state.accentColor,
            fontFamily: state.fontFamily,
            lyricTransition: state.lyricTransition,
            lyricShadow: state.lyricShadow
        }, null, 2);
    }
}));
