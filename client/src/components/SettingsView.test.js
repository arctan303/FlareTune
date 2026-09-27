import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('SettingsView natively embeds theme, player skin, and wallpaper texture without retired public pages', () => {
  const settings = readSource('./SettingsView.jsx');

  // 1. 外观模式
  assert.match(settings, /外观模式/);
  assert.match(settings, /浅色模式/);
  assert.match(settings, /深色模式/);
  assert.match(settings, /跟随系统/);
  assert.match(settings, /selectTheme\?\.\(id\)/);
  assert.match(settings, /aria-pressed=\{themePreference === id\}/);

  // 2. 播放器外观形态与沙盘
  assert.match(settings, /播放器外观/);
  assert.match(settings, /PlayerModeMockup/);
  assert.match(settings, /AVAILABLE_PLAYER_MODES/);
  assert.match(settings, /setPlayerMode/);
  assert.match(settings, /写真/);
  assert.doesNotMatch(settings, /setImmersiveBgMode|沉浸背景：/);

  // 3. 全站壁纸与质感调节
  assert.match(settings, /全站壁纸与质感/);
  assert.match(settings, /toggleEnabled/);
  assert.match(settings, /WALLPAPER_PRESETS/);
  assert.match(settings, /setPreset/);
  assert.match(settings, /setCustomUrl/);
  assert.match(settings, /setLocalImage/);
  assert.match(settings, /removeLocalImage/);
  assert.match(settings, /handleResetDefaults/);
  assert.match(settings, /WALLPAPER_LIMITS/);
  assert.match(settings, /CARD_GLASS_LIMITS/);

  assert.doesNotMatch(settings, /关于与版权|SITE_PROFILE|dmca@arcinks\.com|VERSION/);

  // 4. 抽屉解耦：不使用抽屉包装
  assert.doesNotMatch(settings, /DrawerFrame/);
  assert.doesNotMatch(settings, /useDrawerTransition/);
  assert.doesNotMatch(settings, /setIsBackgroundDrawerOpen\(true\)/);
  assert.doesNotMatch(settings, /setIsSkinPickerOpen\(true\)/);
});
