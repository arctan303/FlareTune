import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSource = (relativePath) => {
  const fileUrl = new URL(relativePath, import.meta.url);
  return readFileSync(fileURLToPath(fileUrl), 'utf-8');
};

test('SettingsView embeds wallpaper and player skin configuration natively', () => {
  const settings = readSource('./SettingsView.jsx');
  assert.match(settings, /全站壁纸/);
  assert.match(settings, /WALLPAPER_PRESETS/);
  assert.match(settings, /toggleEnabled/);
  assert.match(settings, /播放器外观/);
  assert.match(settings, /AVAILABLE_PLAYER_MODES/);
  assert.match(settings, /setPlayerMode/);
});

test('app.jsx registers BackgroundDrawer in OVERLAY_CLOSE_ORDER, secondaryModalOpen and mounts it', () => {
  const app = readSource('../app.jsx');
  assert.match(app, /const\s*\{[^}]*isBackgroundDrawerOpen[^}]*\}\s*=\s*useUIStore/);
  assert.match(app, /BackgroundDrawer = React\.lazy/);
  assert.match(app, /\['isBackgroundDrawerOpen',\s*'setIsBackgroundDrawerOpen'\]/);
  assert.match(app, /secondaryModalOpen =[\s\S]*isBackgroundDrawerOpen/);
  assert.match(app, /hasOpenedBackgroundDrawer && <BackgroundDrawer \/>/);
});

test('ShellEnvironment renders .shell-wallpaper with dynamic CSS filter variables', () => {
  const shell = readSource('./ShellEnvironment.jsx');
  const baseCss = readSource('../styles/base.css');

  assert.match(shell, /import \{ useWallpaperStore \} from '\.\.\/store\/useWallpaperStore'/);
  assert.match(shell, /className="shell-wallpaper"/);
  assert.match(shell, /className="shell-wallpaper__image"/);
  assert.match(shell, /className="shell-wallpaper__overlay"/);
  assert.match(shell, /'--wallpaper-blur':/);
  assert.match(shell, /'--wallpaper-opacity':/);
  assert.match(shell, /'--wallpaper-brightness':/);
  assert.match(shell, /setImageStatus\('error'\)/);
  assert.match(shell, /referrerPolicy="no-referrer"/);
  assert.match(shell, /已恢复默认背景/);

  assert.match(baseCss, /\.shell-wallpaper\s*\{/);
  assert.match(baseCss, /\.shell-wallpaper__image\s*\{/);
  assert.match(baseCss, /\.shell-wallpaper__overlay\s*\{/);
  assert.match(baseCss, /--wallpaper-mask-color/);
});

test('BackgroundDrawer provides presets, custom URL, tuning sliders and reset', () => {
  const drawer = readSource('./BackgroundDrawer.jsx');
  assert.match(drawer, /WALLPAPER_PRESETS/);
  assert.match(drawer, /WALLPAPER_LIMITS/);
  assert.match(drawer, /toggleEnabled/);
  assert.match(drawer, /handleSelectPreset/);
  assert.match(drawer, /handleApplyCustomUrl/);
  assert.match(drawer, /resetDefaults/);
  assert.match(drawer, /type="range"/);
  assert.match(drawer, /setBlur/);
  assert.match(drawer, /setOpacity/);
  assert.match(drawer, /setBrightness/);
  // 本地图片选择能力
  assert.match(drawer, /type="file"/);
  assert.match(drawer, /handleFileChange/);
  assert.match(drawer, /setLocalImage/);
  assert.match(drawer, /removeLocalImage/);
  assert.match(drawer, /IndexedDB/);
  assert.match(drawer, /result\.durable/);
  assert.match(drawer, /仅本次会话有效/);
  assert.match(drawer, /当前图片无法加载，已恢复默认背景/);
  assert.match(drawer, /含敏感签名或令牌/);
  assert.match(drawer, /referrerPolicy="no-referrer"/);
});

test('music-shell reflects wallpaper state and applies frosted glass acrylic to cards', () => {
  const app = readSource('../app.jsx');
  const homeFeatured = readSource('./HomeFeaturedSection.jsx');
  const componentsCss = readSource('../styles/components.css');

  assert.match(app, /import \{ selectHasRenderableWallpaper, useWallpaperStore \} from '\.\/store\/useWallpaperStore(\.js)?'/);
  assert.match(app, /const hasWallpaper = useWallpaperStore\(selectHasRenderableWallpaper\);/);
  assert.match(app, /data-has-wallpaper=\{hasWallpaper \? 'true' : 'false'\}/);

  assert.match(homeFeatured, /className="sound-escape-subcard group text-left h-full flex flex-col justify-between[^"]*"/);
  assert.match(homeFeatured, /sound-escape-subcard__badge/);

  assert.match(componentsCss, /\.music-shell\[data-has-wallpaper='true'\] \.sound-escape-card/);
  assert.match(componentsCss, /\.music-shell\[data-has-wallpaper='true'\] \.sound-escape-subcard/);
  assert.match(componentsCss, /\.music-shell\[data-has-wallpaper='true'\] \.sound-escape-header-bar/);
  assert.match(componentsCss, /backdrop-filter:\s*blur\(16px\)/);
});

test('BackgroundDrawer renders card liquid glass tuning section matching apple.html specifications', () => {
  const drawer = readSource('./BackgroundDrawer.jsx');
  const componentsCss = readSource('../styles/components.css');
  const app = readSource('../app.jsx');

  // UI checks
  assert.match(drawer, /CARD_GLASS_PRESETS/);
  assert.match(drawer, /CARD_GLASS_LIMITS/);
  assert.match(drawer, /setCardOpacity/);
  assert.match(drawer, /setCardGlassPreset/);
  assert.match(drawer, /handleResetDefaults/);
  assert.match(drawer, /画面与卡片质感调节/);
  assert.match(drawer, /卡片通透度 \(Opacity\)/);
  assert.match(drawer, /开启背景壁纸后，画面调节与卡片通透度将实时生效/);

  // App rootStyle CSS vars
  assert.match(app, /'--card-glass-blur':/);
  assert.match(app, /'--card-glass-saturate':/);
  assert.match(app, /'--card-glass-opacity':/);

  // CSS variables in components.css
  assert.match(componentsCss, /--card-glass-blur:\s*36px/);
  assert.match(componentsCss, /--card-glass-saturate:\s*180%/);
  assert.match(componentsCss, /--card-glass-opacity:\s*12%/);
  assert.match(componentsCss, /backdrop-filter:\s*blur\(var\(--card-glass-blur,\s*36px\)\)\s*saturate\(var\(--card-glass-saturate,\s*180%\)\)/);
  assert.match(componentsCss, /color-mix\(in srgb, var\(--surface-raised, #ffffff\) var\(--card-glass-opacity, 12%\), transparent\)/);
});
