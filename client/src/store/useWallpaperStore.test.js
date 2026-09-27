import test from 'node:test';
import assert from 'node:assert/strict';

const memoryStore = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (key) => memoryStore.get(key) ?? null,
    setItem: (key, val) => memoryStore.set(key, String(val)),
    removeItem: (key) => memoryStore.delete(key),
    clear: () => memoryStore.clear(),
  };
}

const { selectHasRenderableWallpaper, useWallpaperStore } = await import('./useWallpaperStore.js');
const {
  CARD_GLASS_LIMITS,
  CARD_GLASS_PRESETS,
  DEFAULT_WALLPAPER_STATE,
  WALLPAPER_LIMITS,
  WALLPAPER_PRESETS,
  resolveActiveWallpaperUrl,
  sanitizeWallpaperState,
} = await import('../constants/wallpaperPresets.js');

test('useWallpaperStore initializes and resets to safe defaults', () => {
  useWallpaperStore.getState().resetDefaults();
  const state = useWallpaperStore.getState();

  assert.equal(state.enabled, false);
  assert.equal(state.activePresetId, 'natural-scenery');
  assert.equal(state.customUrl, '');
  assert.equal(state.blur, WALLPAPER_LIMITS.blur.default);
  assert.equal(state.opacity, WALLPAPER_LIMITS.opacity.default);
  assert.equal(state.brightness, WALLPAPER_LIMITS.brightness.default);
  assert.equal(state.cardBlur, CARD_GLASS_LIMITS.blur.default);
  assert.equal(state.cardSaturate, CARD_GLASS_LIMITS.saturate.default);
  assert.equal(state.cardOpacity, CARD_GLASS_LIMITS.opacity.default);
});

test('useWallpaperStore switches preset and clamps values correctly', () => {
  useWallpaperStore.getState().resetDefaults();

  useWallpaperStore.getState().setPreset('deep-space', true);
  let state = useWallpaperStore.getState();
  assert.equal(state.enabled, true);
  assert.equal(state.activePresetId, 'deep-space');
  assert.equal(state.customUrl, '');

  useWallpaperStore.getState().setBlur(999);
  assert.equal(useWallpaperStore.getState().blur, WALLPAPER_LIMITS.blur.max);

  useWallpaperStore.getState().setBlur(-50);
  assert.equal(useWallpaperStore.getState().blur, WALLPAPER_LIMITS.blur.min);

  useWallpaperStore.getState().setOpacity(150);
  assert.equal(useWallpaperStore.getState().opacity, WALLPAPER_LIMITS.opacity.max);

  useWallpaperStore.getState().setBrightness(10);
  assert.equal(useWallpaperStore.getState().brightness, WALLPAPER_LIMITS.brightness.min);
});

test('useWallpaperStore handles card glass clamping, presets, and resets', () => {
  useWallpaperStore.getState().resetDefaults();
  useWallpaperStore.getState().resetCardGlassDefaults();
  let state = useWallpaperStore.getState();
  assert.equal(state.cardBlur, CARD_GLASS_LIMITS.blur.default);
  assert.equal(state.cardSaturate, CARD_GLASS_LIMITS.saturate.default);
  assert.equal(state.cardOpacity, CARD_GLASS_LIMITS.opacity.default);

  // Clamping
  useWallpaperStore.getState().setCardBlur(999);
  assert.equal(useWallpaperStore.getState().cardBlur, CARD_GLASS_LIMITS.blur.max);
  useWallpaperStore.getState().setCardBlur(-20);
  assert.equal(useWallpaperStore.getState().cardBlur, CARD_GLASS_LIMITS.blur.min);

  useWallpaperStore.getState().setCardSaturate(500);
  assert.equal(useWallpaperStore.getState().cardSaturate, CARD_GLASS_LIMITS.saturate.max);
  useWallpaperStore.getState().setCardSaturate(20);
  assert.equal(useWallpaperStore.getState().cardSaturate, CARD_GLASS_LIMITS.saturate.min);

  useWallpaperStore.getState().setCardOpacity(100);
  assert.equal(useWallpaperStore.getState().cardOpacity, CARD_GLASS_LIMITS.opacity.max);
  useWallpaperStore.getState().setCardOpacity(-15);
  assert.equal(useWallpaperStore.getState().cardOpacity, CARD_GLASS_LIMITS.opacity.min);

  // Presets (holistic for wallpaper and cards)
  useWallpaperStore.getState().setCardGlassPreset('clear');
  state = useWallpaperStore.getState();
  assert.equal(state.blur, CARD_GLASS_PRESETS.clear.wallpaperBlur);
  assert.equal(state.opacity, CARD_GLASS_PRESETS.clear.wallpaperOpacity);
  assert.equal(state.cardBlur, CARD_GLASS_PRESETS.clear.blur);
  assert.equal(state.cardSaturate, CARD_GLASS_PRESETS.clear.saturate);
  assert.equal(state.cardOpacity, CARD_GLASS_PRESETS.clear.opacity);

  useWallpaperStore.getState().setCardGlassPreset('frosted');
  state = useWallpaperStore.getState();
  assert.equal(state.blur, CARD_GLASS_PRESETS.frosted.wallpaperBlur);
  assert.equal(state.opacity, CARD_GLASS_PRESETS.frosted.wallpaperOpacity);
  assert.equal(state.cardBlur, CARD_GLASS_PRESETS.frosted.blur);
  assert.equal(state.cardSaturate, CARD_GLASS_PRESETS.frosted.saturate);
  assert.equal(state.cardOpacity, CARD_GLASS_PRESETS.frosted.opacity);

  useWallpaperStore.getState().setCardGlassPreset('tinted');
  state = useWallpaperStore.getState();
  assert.equal(state.blur, CARD_GLASS_PRESETS.tinted.wallpaperBlur);
  assert.equal(state.opacity, CARD_GLASS_PRESETS.tinted.wallpaperOpacity);
  assert.equal(state.cardBlur, CARD_GLASS_PRESETS.tinted.blur);
  assert.equal(state.cardSaturate, CARD_GLASS_PRESETS.tinted.saturate);
  assert.equal(state.cardOpacity, CARD_GLASS_PRESETS.tinted.opacity);

  // Reset
  useWallpaperStore.getState().resetCardGlassDefaults();
  state = useWallpaperStore.getState();
  assert.equal(state.cardBlur, CARD_GLASS_LIMITS.blur.default);
  assert.equal(state.cardSaturate, CARD_GLASS_LIMITS.saturate.default);
  assert.equal(state.cardOpacity, CARD_GLASS_LIMITS.opacity.default);
});

test('useWallpaperStore applies theme-specific card glass parameters when switching preset', () => {
  // Deep space theme
  useWallpaperStore.getState().setPreset('deep-space', true);
  let state = useWallpaperStore.getState();
  const deepSpace = WALLPAPER_PRESETS.find((p) => p.id === 'deep-space');
  assert.equal(state.blur, deepSpace.defaultBlur);
  assert.equal(state.cardBlur, deepSpace.defaultCardBlur);
  assert.equal(state.cardSaturate, deepSpace.defaultCardSaturate);
  assert.equal(state.cardOpacity, deepSpace.defaultCardOpacity);

  // Sunset glow theme
  useWallpaperStore.getState().setPreset('sunset-glow', true);
  state = useWallpaperStore.getState();
  const sunset = WALLPAPER_PRESETS.find((p) => p.id === 'sunset-glow');
  assert.equal(state.blur, sunset.defaultBlur);
  assert.equal(state.cardBlur, sunset.defaultCardBlur);
  assert.equal(state.cardSaturate, sunset.defaultCardSaturate);
  assert.equal(state.cardOpacity, sunset.defaultCardOpacity);

  // Misty peaks theme
  useWallpaperStore.getState().setPreset('misty-peaks', true);
  state = useWallpaperStore.getState();
  const misty = WALLPAPER_PRESETS.find((p) => p.id === 'misty-peaks');
  assert.equal(state.cardBlur, misty.defaultCardBlur);
  assert.equal(state.cardSaturate, misty.defaultCardSaturate);
  assert.equal(state.cardOpacity, misty.defaultCardOpacity);

  // Dark minimal theme
  useWallpaperStore.getState().setPreset('dark-minimal', true);
  state = useWallpaperStore.getState();
  const darkMin = WALLPAPER_PRESETS.find((p) => p.id === 'dark-minimal');
  assert.equal(state.cardBlur, darkMin.defaultCardBlur);
  assert.equal(state.cardSaturate, darkMin.defaultCardSaturate);
  assert.equal(state.cardOpacity, darkMin.defaultCardOpacity);

  // Reset defaults restores default card glass parameters
  useWallpaperStore.getState().setCardBlur(10);
  useWallpaperStore.getState().resetCardGlassDefaults();
  state = useWallpaperStore.getState();
  assert.equal(state.cardBlur, DEFAULT_WALLPAPER_STATE.cardBlur);
});

test('resolveActiveWallpaperUrl prioritizes custom URL over preset when enabled', () => {
  assert.equal(resolveActiveWallpaperUrl({ enabled: false }), null);

  const customState = {
    enabled: true,
    activePresetId: 'natural-scenery',
    customUrl: 'https://example.com/custom.webp',
  };
  assert.equal(resolveActiveWallpaperUrl(customState), 'https://example.com/custom.webp');

  const presetState = {
    enabled: true,
    activePresetId: 'misty-peaks',
    customUrl: '   ',
  };
  const expectedPreset = WALLPAPER_PRESETS.find((p) => p.id === 'misty-peaks');
  assert.equal(resolveActiveWallpaperUrl(presetState), expectedPreset.url);
});

test('sanitizeWallpaperState prevents invalid structures', () => {
  const sanitized = sanitizeWallpaperState({
    enabled: 'yes',
    activePresetId: 'non-existent-preset',
    blur: 'invalid',
    opacity: -10,
    brightness: 9999,
    cardBlur: 'abc',
    cardSaturate: -100,
    cardOpacity: 888,
  });

  assert.equal(sanitized.enabled, true);
  assert.equal(sanitized.activePresetId, DEFAULT_WALLPAPER_STATE.activePresetId);
  assert.equal(sanitized.blur, WALLPAPER_LIMITS.blur.default);
  assert.equal(sanitized.opacity, WALLPAPER_LIMITS.opacity.min);
  assert.equal(sanitized.brightness, WALLPAPER_LIMITS.brightness.max);
  assert.equal(sanitized.cardBlur, CARD_GLASS_LIMITS.blur.default);
  assert.equal(sanitized.cardSaturate, CARD_GLASS_LIMITS.saturate.min);
  assert.equal(sanitized.cardOpacity, CARD_GLASS_LIMITS.opacity.max);
});

test('useWallpaperStore handles local image lifecycle and priority', async () => {
  useWallpaperStore.getState().resetDefaults();

  const fakeBlob = new Blob(['mock binary image data'], { type: 'image/jpeg' });
  fakeBlob.name = 'my-wallpaper.jpg';
  const saved = await useWallpaperStore.getState().setLocalImage(fakeBlob);
  assert.equal(saved.ok, true);
  assert.equal(saved.durable, false);

  let state = useWallpaperStore.getState();
  assert.equal(state.enabled, true);
  assert.equal(state.hasLocalImage, true);
  assert.equal(state.localImageName, 'my-wallpaper.jpg');
  assert.equal(state.activeSource, 'local');
  assert.equal(state.localImagePersistence, 'volatile');

  // resolveActiveWallpaperUrl should prioritize local image when activeSource === 'local'
  const localUrl = 'blob:http://localhost/test-uuid';
  useWallpaperStore.setState({ localImageUrl: localUrl });
  assert.equal(useWallpaperStore.getState().getActiveUrl(), localUrl);

  // Switching preset changes activeSource to 'preset'
  useWallpaperStore.getState().setPreset('sunset-glow');
  state = useWallpaperStore.getState();
  assert.equal(state.activeSource, 'preset');
  assert.match(state.getActiveUrl(), /images\.unsplash\.com/);

  // Switching back to local source
  useWallpaperStore.getState().setActiveSource('local');
  assert.equal(useWallpaperStore.getState().getActiveUrl(), localUrl);

  // Removing local image
  const deleted = await useWallpaperStore.getState().removeLocalImage();
  assert.equal(deleted.ok, true);
  state = useWallpaperStore.getState();
  assert.equal(state.hasLocalImage, false);
  assert.equal(state.localImageName, '');
  assert.equal(state.localImageUrl, '');
  assert.equal(state.activeSource, 'preset');
});

test('renderable wallpaper selector disables acrylic until load succeeds and after load errors', () => {
  useWallpaperStore.getState().setPreset('deep-space');
  assert.equal(selectHasRenderableWallpaper(useWallpaperStore.getState()), false);

  useWallpaperStore.getState().setImageStatus('ready');
  assert.equal(selectHasRenderableWallpaper(useWallpaperStore.getState()), true);

  useWallpaperStore.getState().setImageStatus('error');
  assert.equal(selectHasRenderableWallpaper(useWallpaperStore.getState()), false);
});

test('failed durable deletion keeps the local wallpaper active for retry', async () => {
  const originalWindow = globalThis.window;
  const failedDeleteDb = {
    open() {
      const request = {};
      queueMicrotask(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction() {
            const tx = {
              error: new Error('forced delete failure'),
              objectStore: () => ({
                delete() {
                  const operation = {};
                  queueMicrotask(() => {
                    operation.error = tx.error;
                    operation.onerror?.();
                    tx.onerror?.();
                    tx.onabort?.();
                  });
                  return operation;
                },
              }),
            };
            return tx;
          },
        };
        request.result = db;
        request.onsuccess?.({ target: request });
      });
      return request;
    },
  };
  globalThis.window = { indexedDB: failedDeleteDb };
  useWallpaperStore.setState({
    enabled: true,
    activeSource: 'local',
    hasLocalImage: true,
    localImageName: 'keep-me.png',
    localImageUrl: 'blob:keep-me',
    localImagePersistence: 'durable',
    imageStatus: 'ready',
  });

  try {
    const deleted = await useWallpaperStore.getState().removeLocalImage();
    assert.equal(deleted.ok, false);
    const state = useWallpaperStore.getState();
    assert.equal(state.hasLocalImage, true);
    assert.equal(state.localImageUrl, 'blob:keep-me');
    assert.equal(state.activeSource, 'local');
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
