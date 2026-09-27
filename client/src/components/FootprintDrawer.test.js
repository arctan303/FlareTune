import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('FootprintDrawer provides accessible frame, rank medals, play counts, and play all action', () => {
  const drawer = readSource('./FootprintDrawer.jsx');

  assert.match(drawer, /DrawerFrame/);
  assert.match(drawer, /useDrawerTransition/);
  assert.match(drawer, /labelledBy="footprint-drawer-title"/);
  assert.match(drawer, /usePlayStatsStore/);
  assert.match(drawer, /topSongs/);
  assert.match(drawer, /totalPlays/);
  assert.match(drawer, /play_count/);
  assert.match(drawer, /次/);
  assert.match(drawer, /handlePlayAll/);
  assert.match(drawer, /handleKeyboardActivation/);
  assert.match(drawer, /group-focus-within:opacity-100/);
  assert.match(drawer, /aria-label=\{\`播放 \$\{song\.title\}\`\}/);
  assert.match(drawer, /播放全部/);
  assert.match(drawer, /handleEscape|key === 'Escape'/);
  assert.match(drawer, /previousFocusRef/);
  assert.match(drawer, /closeButtonRef/);
});

test('useUIStore integrates isFootprintDrawerOpen with mutual exclusivity', () => {
  const store = readSource('../store/useUIStore.js');

  assert.match(store, /isFootprintDrawerOpen: false/);
  assert.match(store, /setIsFootprintDrawerOpen/);
  assert.match(store, /usePlayStatsStore\.getState\(\)\.setSubject\(nextAccountId\)/);
});

test('app mounts FootprintDrawer with lazy code splitting and overlay intercept', () => {
  const app = readSource('../app.jsx');

  assert.match(app, /FootprintDrawer = React\.lazy/);
  assert.match(app, /hasOpenedFootprintDrawer && <FootprintDrawer \/>/);
  assert.match(app, /const \{[^}]*isFootprintDrawerOpen[^}]*\} = useUIStore/);
  assert.match(app, /isFootprintDrawerOpen/);
});

test('HomeFeaturedSection wires footprint card to FootprintDrawer', () => {
  const featured = readSource('./HomeFeaturedSection.jsx');

  assert.match(featured, /import \{[^}]*useUIStore[^}]*\} from '\.\.\/store\/useUIStore\.js'/);
  assert.match(featured, /setIsFootprintDrawerOpen\(true\)/);
  assert.match(featured, /常听足迹/);
});

test('FootprintDrawer provides cloud records refresh action with graceful feedback', () => {
  const drawer = readSource('./FootprintDrawer.jsx');

  assert.match(drawer, /handleRefresh/);
  assert.match(drawer, /synchronizeAccountStats\(50/);
  assert.match(drawer, /if \(!result\.ok\) throw/);
  assert.match(drawer, /isRefreshing/);
  assert.match(drawer, /刷新/);
  assert.match(drawer, /transition-opacity/);
  assert.doesNotMatch(drawer, /本地播放统计|访客/);
});

test('FootprintDrawer follows Rules of Hooks with all hooks called unconditionally before early return', () => {
  const drawer = readSource('./FootprintDrawer.jsx');

  const mountedCheckIndex = drawer.indexOf('if (!mounted) return null;');
  const useStateIndex = drawer.indexOf('useState(');
  const usePlayStatsIndex = drawer.indexOf('usePlayStatsStore(');

  assert.ok(mountedCheckIndex > -1);
  assert.ok(useStateIndex > -1 && useStateIndex < mountedCheckIndex, 'useState must be called before if (!mounted) return null');
  assert.ok(usePlayStatsIndex > -1 && usePlayStatsIndex < mountedCheckIndex, 'usePlayStatsStore must be called before if (!mounted) return null');
});

test('FootprintDrawer heals missing song language from current player state and server fallback', () => {
  const drawer = readSource('./FootprintDrawer.jsx');

  assert.doesNotMatch(drawer, /getLocalCachedSongMap|localStorage/);
  assert.match(drawer, /fillSongMetadata/);
  assert.match(drawer, /songHasValidLanguage/);
  assert.match(drawer, /repairSongLanguages/);
  assert.match(drawer, /patchSongMetadata/);
});
