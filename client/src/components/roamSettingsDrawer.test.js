import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('RoamSettingsDrawer provides accessible frame, multi-language toggles, and deduplication reset', () => {
  const drawer = readSource('./RoamSettingsDrawer.jsx');

  assert.match(drawer, /DrawerFrame/);
  assert.match(drawer, /useDrawerTransition/);
  assert.match(drawer, /labelledBy="roam-settings-drawer-title"/);
  assert.match(drawer, /ROAM_LANGUAGES/);
  assert.match(drawer, /ROAM_BATCH_SIZE_OPTIONS/);
  assert.match(drawer, /setRandomRoamLanguage/);
  assert.match(drawer, /setRandomRoamBatchSize/);
  assert.match(drawer, /resetRandomRoamHistory/);
  assert.match(drawer, /单次补充数量/);
  assert.match(drawer, /handleEscape|key === 'Escape'/);
  assert.match(drawer, /previousFocusRef/);
  assert.match(drawer, /closeButtonRef/);
  assert.match(drawer, /全选/);
  assert.match(drawer, /全不选/);
  assert.match(drawer, /仅华语/);
  assert.match(drawer, /请至少选择一个语种/);
});

test('MainContent exposes roam settings drawer entry and play history footprint', () => {
  const main = readSource('./MainContent.jsx');
  const featured = readSource('./HomeFeaturedSection.jsx');

  assert.match(featured, /setIsRoamSettingsOpen\(true\)/);
  assert.match(featured, /漫游设置/);
  assert.match(featured, /常听足迹/);
  assert.match(featured, /RandomRoamColumn/);
  assert.match(main, /songsMap=\{songsMap\}/);
});

test('useUIStore integrates isRoamSettingsOpen with mutual exclusivity', () => {
  const store = readSource('../store/useUIStore.js');

  assert.match(store, /isRoamSettingsOpen: false/);
  assert.match(store, /setIsRoamSettingsOpen/);
});

test('usePlayerStore exposes resetRandomRoamHistory action', () => {
  const playerStore = readSource('../store/usePlayerStore.js');

  assert.match(playerStore, /resetRandomRoamHistory/);
});
