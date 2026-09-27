import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  CARD_GLASS_LIMITS,
  CARD_GLASS_PRESETS,
  DEFAULT_WALLPAPER_STATE,
  WALLPAPER_LIMITS,
  WALLPAPER_PRESETS,
  clampValue,
  resolveActiveWallpaperUrl,
  sanitizeWallpaperState,
} from '../constants/wallpaperPresets.js';
import {
  saveLocalWallpaperBlob,
  getLocalWallpaperBlob,
  deleteLocalWallpaperBlob,
} from '../utils/wallpaperDb.js';

const getNextImageStatus = (state) => (
  resolveActiveWallpaperUrl(state) ? 'loading' : 'idle'
);

export const selectHasRenderableWallpaper = (state) => Boolean(
  state.enabled
  && state.imageStatus === 'ready'
  && resolveActiveWallpaperUrl(state),
);

const getSafeStorage = () => {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
};

export const useWallpaperStore = create(
  persist(
    (set, get) => ({
      enabled: DEFAULT_WALLPAPER_STATE.enabled,
      activeSource: DEFAULT_WALLPAPER_STATE.activeSource,
      activePresetId: DEFAULT_WALLPAPER_STATE.activePresetId,
      customUrl: DEFAULT_WALLPAPER_STATE.customUrl,
      hasLocalImage: DEFAULT_WALLPAPER_STATE.hasLocalImage,
      localImageName: DEFAULT_WALLPAPER_STATE.localImageName,
      localImageUrl: '',
      localImagePersistence: 'none',
      imageStatus: 'idle',
      blur: DEFAULT_WALLPAPER_STATE.blur,
      opacity: DEFAULT_WALLPAPER_STATE.opacity,
      brightness: DEFAULT_WALLPAPER_STATE.brightness,
      cardBlur: DEFAULT_WALLPAPER_STATE.cardBlur,
      cardSaturate: DEFAULT_WALLPAPER_STATE.cardSaturate,
      cardOpacity: DEFAULT_WALLPAPER_STATE.cardOpacity,

      setEnabled: (val) => {
        const enabled = typeof val === 'function' ? Boolean(val(get().enabled)) : Boolean(val);
        const nextState = { ...get(), enabled };
        set({ enabled, imageStatus: getNextImageStatus(nextState) });
      },

      toggleEnabled: () => {
        const nextState = { ...get(), enabled: !get().enabled };
        set({ enabled: nextState.enabled, imageStatus: getNextImageStatus(nextState) });
      },

      setActiveSource: (source) => {
        const validSources = ['preset', 'custom', 'local'];
        if (validSources.includes(source)) {
          const nextState = { ...get(), activeSource: source };
          set({ activeSource: source, imageStatus: getNextImageStatus(nextState) });
        }
      },

      setPreset: (presetId, applyDefaults = false) => {
        const preset = WALLPAPER_PRESETS.find((p) => p.id === presetId);
        if (!preset) return;
        set({
          activeSource: 'preset',
          activePresetId: preset.id,
          enabled: true,
          imageStatus: 'loading',
          ...(applyDefaults ? {
            blur: preset.defaultBlur,
            opacity: preset.defaultOpacity,
            brightness: preset.defaultBrightness,
            ...(preset.defaultCardBlur !== undefined ? { cardBlur: preset.defaultCardBlur } : {}),
            ...(preset.defaultCardSaturate !== undefined ? { cardSaturate: preset.defaultCardSaturate } : {}),
            ...(preset.defaultCardOpacity !== undefined ? { cardOpacity: preset.defaultCardOpacity } : {}),
          } : {}),
        });
      },

      setCustomUrl: (url) => {
        const safeUrl = typeof url === 'string' ? url.trim() : '';
        const nextState = {
          ...get(),
          activeSource: 'custom',
          customUrl: safeUrl,
          enabled: safeUrl.length > 0 ? true : get().enabled,
        };
        set({
          activeSource: nextState.activeSource,
          customUrl: nextState.customUrl,
          enabled: nextState.enabled,
          imageStatus: getNextImageStatus(nextState),
        });
      },

      setLocalImage: async (file) => {
        if (!file) return { ok: false, durable: false, reason: 'missing-file' };
        const fileName = file.name || 'custom-wallpaper';
        const persistenceResult = await saveLocalWallpaperBlob(file, {
          name: fileName,
          size: file.size,
          type: file.type,
        });

        const prevUrl = get().localImageUrl;
        if (prevUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
          try { URL.revokeObjectURL(prevUrl); } catch (_) {}
        }

        let nextUrl = '';
        if (typeof URL !== 'undefined' && URL.createObjectURL) {
          try {
            nextUrl = URL.createObjectURL(file);
          } catch (_) {}
        }

        set({
          activeSource: 'local',
          hasLocalImage: true,
          localImageName: fileName,
          localImageUrl: nextUrl,
          localImagePersistence: persistenceResult.durable ? 'durable' : 'volatile',
          imageStatus: nextUrl ? 'loading' : 'error',
          enabled: true,
        });
        return persistenceResult;
      },

      initLocalImage: async () => {
        const { hasLocalImage, localImageUrl } = get();
        if (!hasLocalImage || localImageUrl) return;

        try {
          const record = await getLocalWallpaperBlob();
          if (record && record.blob) {
            let objectUrl = '';
            if (typeof URL !== 'undefined' && URL.createObjectURL) {
              try {
                objectUrl = URL.createObjectURL(record.blob);
              } catch (_) {}
            }
            set({
              localImageUrl: objectUrl,
              localImageName: record.name || get().localImageName,
              localImagePersistence: record.persistence || 'durable',
              imageStatus: objectUrl ? 'loading' : 'error',
            });
          } else {
            set({
              hasLocalImage: false,
              localImageName: '',
              localImageUrl: '',
              localImagePersistence: 'none',
              activeSource: get().activeSource === 'local' ? 'preset' : get().activeSource,
              imageStatus: get().enabled ? 'loading' : 'idle',
            });
          }
        } catch (err) {
          console.warn('[wallpaperStore] 初始化本地壁纸失败:', err);
        }
      },

      removeLocalImage: async () => {
        const persistenceResult = await deleteLocalWallpaperBlob();
        if (!persistenceResult.ok) return persistenceResult;
        const prevUrl = get().localImageUrl;
        if (prevUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
          try { URL.revokeObjectURL(prevUrl); } catch (_) {}
        }

        set({
          hasLocalImage: false,
          localImageName: '',
          localImageUrl: '',
          localImagePersistence: 'none',
          activeSource: get().activeSource === 'local' ? 'preset' : get().activeSource,
          imageStatus: get().enabled ? 'loading' : 'idle',
        });
        return persistenceResult;
      },

      setImageStatus: (status) => {
        if (['idle', 'loading', 'ready', 'error'].includes(status)) {
          set({ imageStatus: status });
        }
      },

      setBlur: (val) => set({
        blur: clampValue(val, WALLPAPER_LIMITS.blur.min, WALLPAPER_LIMITS.blur.max, WALLPAPER_LIMITS.blur.default),
      }),

      setOpacity: (val) => set({
        opacity: clampValue(val, WALLPAPER_LIMITS.opacity.min, WALLPAPER_LIMITS.opacity.max, WALLPAPER_LIMITS.opacity.default),
      }),

      setBrightness: (val) => set({
        brightness: clampValue(val, WALLPAPER_LIMITS.brightness.min, WALLPAPER_LIMITS.brightness.max, WALLPAPER_LIMITS.brightness.default),
      }),

      setCardBlur: (val) => set({
        cardBlur: clampValue(val, CARD_GLASS_LIMITS.blur.min, CARD_GLASS_LIMITS.blur.max, CARD_GLASS_LIMITS.blur.default),
      }),

      setCardSaturate: (val) => set({
        cardSaturate: clampValue(val, CARD_GLASS_LIMITS.saturate.min, CARD_GLASS_LIMITS.saturate.max, CARD_GLASS_LIMITS.saturate.default),
      }),

      setCardOpacity: (val) => set({
        cardOpacity: clampValue(val, CARD_GLASS_LIMITS.opacity.min, CARD_GLASS_LIMITS.opacity.max, CARD_GLASS_LIMITS.opacity.default),
      }),

      setCardGlassPreset: (presetKey) => {
        const preset = CARD_GLASS_PRESETS[presetKey];
        if (!preset) return;
        set({
          cardBlur: preset.blur,
          cardSaturate: preset.saturate,
          cardOpacity: preset.opacity,
          ...(preset.wallpaperBlur !== undefined ? { blur: preset.wallpaperBlur } : {}),
          ...(preset.wallpaperOpacity !== undefined ? { opacity: preset.wallpaperOpacity } : {}),
        });
      },

      resetCardGlassDefaults: () => set({
        cardBlur: DEFAULT_WALLPAPER_STATE.cardBlur,
        cardSaturate: DEFAULT_WALLPAPER_STATE.cardSaturate,
        cardOpacity: DEFAULT_WALLPAPER_STATE.cardOpacity,
      }),

      resetDefaults: () => set({
        blur: DEFAULT_WALLPAPER_STATE.blur,
        opacity: DEFAULT_WALLPAPER_STATE.opacity,
        brightness: DEFAULT_WALLPAPER_STATE.brightness,
        cardBlur: DEFAULT_WALLPAPER_STATE.cardBlur,
        cardSaturate: DEFAULT_WALLPAPER_STATE.cardSaturate,
        cardOpacity: DEFAULT_WALLPAPER_STATE.cardOpacity,
      }),

      getActiveUrl: () => resolveActiveWallpaperUrl(get()),
    }),
    {
      name: 'musicPlayer_wallpaper',
      version: 2,
      storage: createJSONStorage(getSafeStorage),
      migrate: (persistedState) => sanitizeWallpaperState(persistedState),
      partialize: (state) => ({
        enabled: state.enabled,
        activeSource: state.activeSource,
        activePresetId: state.activePresetId,
        customUrl: state.customUrl,
        hasLocalImage: state.hasLocalImage,
        localImageName: state.localImageName,
        blur: state.blur,
        opacity: state.opacity,
        brightness: state.brightness,
        cardBlur: state.cardBlur,
        cardSaturate: state.cardSaturate,
        cardOpacity: state.cardOpacity,
      }),
    }
  )
);
