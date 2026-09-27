import { getBaseUrl } from '../utils.js';

const withBaseUrl = (path) => `${getBaseUrl()}${path.replace(/^\/+/, '')}`;

export const WALLPAPER_LIMITS = Object.freeze({
  blur: { min: 0, max: 40, step: 2, default: 16 },
  opacity: { min: 10, max: 90, step: 5, default: 45 },
  brightness: { min: 60, max: 120, step: 5, default: 90 },
});

export const WALLPAPER_PRESETS = Object.freeze([
  {
    id: 'natural-scenery',
    name: '山野幽林',
    description: '青峰雾霭与自然山林',
    url: withBaseUrl('background/natural-scenery-poster.jpg'),
    thumbnailUrl: withBaseUrl('background/natural-scenery-poster.jpg'),
    defaultBlur: 16,
    defaultOpacity: 45,
    defaultBrightness: 90,
    defaultCardBlur: 36,
    defaultCardSaturate: 180,
    defaultCardOpacity: 12,
  },
  {
    id: 'deep-space',
    name: '深邃星穹',
    description: '幽蓝星云与静默宇宙',
    url: 'https://images.unsplash.com/photo-1506703719100-a0f3a48c0f86?auto=format&fit=crop&w=2560&q=80',
    thumbnailUrl: 'https://images.unsplash.com/photo-1506703719100-a0f3a48c0f86?auto=format&fit=crop&w=400&q=70',
    defaultBlur: 14,
    defaultOpacity: 40,
    defaultBrightness: 85,
    defaultCardBlur: 42,
    defaultCardSaturate: 160,
    defaultCardOpacity: 16,
  },
  {
    id: 'sunset-glow',
    name: '余晖晚霞',
    description: '温润橙粉暮光海景',
    url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=2560&q=80',
    thumbnailUrl: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=400&q=70',
    defaultBlur: 18,
    defaultOpacity: 50,
    defaultBrightness: 95,
    defaultCardBlur: 28,
    defaultCardSaturate: 220,
    defaultCardOpacity: 10,
  },
  {
    id: 'misty-peaks',
    name: '云海群峰',
    description: '层峦叠嶂与空灵群山',
    url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=2560&q=80',
    thumbnailUrl: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=400&q=70',
    defaultBlur: 16,
    defaultOpacity: 45,
    defaultBrightness: 90,
    defaultCardBlur: 20,
    defaultCardSaturate: 140,
    defaultCardOpacity: 8,
  },
  {
    id: 'dark-minimal',
    name: '暗调织物',
    description: '低敛极简深色纹理',
    url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=2560&q=80',
    thumbnailUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=400&q=70',
    defaultBlur: 12,
    defaultOpacity: 35,
    defaultBrightness: 85,
    defaultCardBlur: 48,
    defaultCardSaturate: 120,
    defaultCardOpacity: 18,
  },
]);

export const CARD_GLASS_LIMITS = Object.freeze({
  blur: { min: 4, max: 80, step: 1, default: 36 },
  saturate: { min: 100, max: 300, step: 5, default: 180 },
  opacity: { min: 0, max: 60, step: 1, default: 12 },
});

export const CARD_GLASS_PRESETS = Object.freeze({
  clear: { id: 'clear', name: '超透清澈', wallpaperBlur: 8, wallpaperOpacity: 35, blur: 16, saturate: 140, opacity: 6 },
  tinted: { id: 'tinted', name: '暗调微光', wallpaperBlur: 16, wallpaperOpacity: 45, blur: 36, saturate: 180, opacity: 12 },
  frosted: { id: 'frosted', name: '重度磨砂', wallpaperBlur: 28, wallpaperOpacity: 60, blur: 52, saturate: 220, opacity: 25 },
});

export const DEFAULT_WALLPAPER_STATE = Object.freeze({
  enabled: false,
  activeSource: 'preset', // 'preset' | 'custom' | 'local'
  activePresetId: 'natural-scenery',
  customUrl: '',
  hasLocalImage: false,
  localImageName: '',
  blur: WALLPAPER_LIMITS.blur.default,
  opacity: WALLPAPER_LIMITS.opacity.default,
  brightness: WALLPAPER_LIMITS.brightness.default,
  cardBlur: CARD_GLASS_LIMITS.blur.default,
  cardSaturate: CARD_GLASS_LIMITS.saturate.default,
  cardOpacity: CARD_GLASS_LIMITS.opacity.default,
});

export const clampValue = (val, min, max, fallback) => {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
};

export const sanitizeWallpaperState = (state) => {
  const source = state && typeof state === 'object' ? state : {};
  const activePresetId = typeof source.activePresetId === 'string'
    && WALLPAPER_PRESETS.some((p) => p.id === source.activePresetId)
    ? source.activePresetId
    : DEFAULT_WALLPAPER_STATE.activePresetId;

  const customUrl = typeof source.customUrl === 'string' ? source.customUrl.trim() : '';
  const validSources = ['preset', 'custom', 'local'];
  const activeSource = validSources.includes(source.activeSource)
    ? source.activeSource
    : (customUrl ? 'custom' : 'preset');

  return {
    enabled: Boolean(source.enabled),
    activeSource,
    activePresetId,
    customUrl,
    hasLocalImage: Boolean(source.hasLocalImage),
    localImageName: typeof source.localImageName === 'string' ? source.localImageName : '',
    blur: clampValue(source.blur, WALLPAPER_LIMITS.blur.min, WALLPAPER_LIMITS.blur.max, WALLPAPER_LIMITS.blur.default),
    opacity: clampValue(source.opacity, WALLPAPER_LIMITS.opacity.min, WALLPAPER_LIMITS.opacity.max, WALLPAPER_LIMITS.opacity.default),
    brightness: clampValue(source.brightness, WALLPAPER_LIMITS.brightness.min, WALLPAPER_LIMITS.brightness.max, WALLPAPER_LIMITS.brightness.default),
    cardBlur: clampValue(source.cardBlur, CARD_GLASS_LIMITS.blur.min, CARD_GLASS_LIMITS.blur.max, CARD_GLASS_LIMITS.blur.default),
    cardSaturate: clampValue(source.cardSaturate, CARD_GLASS_LIMITS.saturate.min, CARD_GLASS_LIMITS.saturate.max, CARD_GLASS_LIMITS.saturate.default),
    cardOpacity: clampValue(source.cardOpacity, CARD_GLASS_LIMITS.opacity.min, CARD_GLASS_LIMITS.opacity.max, CARD_GLASS_LIMITS.opacity.default),
  };
};

export const resolveActiveWallpaperUrl = (state) => {
  if (!state || !state.enabled) return null;
  if (state.activeSource === 'local' && state.localImageUrl) {
    return state.localImageUrl;
  }
  if (state.activeSource === 'custom' && state.customUrl && typeof state.customUrl === 'string' && state.customUrl.trim()) {
    return state.customUrl.trim();
  }
  // 向后兼容未持久化 activeSource 的早期状态
  if (!state.activeSource && state.customUrl && typeof state.customUrl === 'string' && state.customUrl.trim()) {
    return state.customUrl.trim();
  }
  const preset = WALLPAPER_PRESETS.find((p) => p.id === state.activePresetId) || WALLPAPER_PRESETS[0];
  return preset ? preset.url : null;
};
