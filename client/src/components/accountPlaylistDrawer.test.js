import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (path) => {
  const url = new URL(path, import.meta.url);
  const content = readFileSync(url, 'utf8');
  if (path.endsWith('.css')) {
    return content.replace(/@import\s+['"](\.[^'"]+)['"];/g, (_, importPath) => {
      const targetUrl = new URL(importPath, url);
      return readFileSync(targetUrl, 'utf8');
    });
  }
  return content;
};

test('account playlist drawer uses the shared lifecycle and fixed scroll geometry', () => {
  const drawer = readSource('./AccountPlaylistDrawer.jsx');
  const css = readSource('../index.css');

  assert.match(drawer, /<DrawerFrame/);
  assert.match(drawer, /useDrawerTransition\(isOpen\)/);
  assert.match(drawer, /panelClassName="account-playlist-drawer sm:w-\[440px\] max-w-full"/);
  assert.match(drawer, /account-playlist-header/);
  assert.match(drawer, /account-playlist-body custom-scrollbar/);
  assert.match(drawer, /account-playlist-footer/);
  assert.match(css, /\.account-playlist-drawer \{[\s\S]*?width: 440px/);
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*?\.account-playlist-drawer \{[\s\S]*?width: 100%/);
  assert.match(css, /\.account-playlist-body \{[\s\S]*?overflow-y: auto/);
  assert.match(css, /\.account-playlist-footer \{[\s\S]*?env\(safe-area-inset-bottom\)[\s\S]*?background: var\(--drawer-solid-bg\)/);
});

test('account storage failures remain visible and retryable instead of appearing as an empty shelf', () => {
  const drawer = readSource('./AccountPlaylistDrawer.jsx');
  const main = readSource('./MainContent.jsx');
  const home = readSource('./HomeOverview.jsx');

  assert.match(home, /个人歌单暂时不可用/);
  assert.doesNotMatch(home, /系统歌单仍可浏览/);
  assert.match(home, /onRetryAccount/);
  assert.match(main, /retryAccountPlaylists/);
  assert.match(drawer, /accountStatus === 'error' && !shelf/);
  assert.match(drawer, /账号唱片架加载失败/);
  assert.match(drawer, /retryAccountData/);
  assert.match(drawer, /accountStatus === 'ready' && shelfRevision !== null/);
});

test('pointer sorting is handle-only, cancellable, scroll-aware and keyboard-equivalent', () => {
  const drawer = readSource('./AccountPlaylistDrawer.jsx');
  const dragHook = readSource('../hooks/useVerticalReorderDrag.js');
  const buttons = readSource('./OrderingButtons.jsx');
  const css = readSource('../index.css');

  assert.ok((drawer.match(/account-order-handle/g) || []).length >= 1);
  assert.match(css, /\.account-order-handle \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;[\s\S]*?touch-action: none/);
  assert.match(css, /\.account-order-buttons button \{[\s\S]*?width: 44px;[\s\S]*?height: 44px/);
  assert.equal((css.match(/touch-action: none/g) || []).length, 1);
  assert.match(drawer, /onPointerCancel=\{\(event\) => finishPointerDrag\(event, true\)\}/);
  assert.match(drawer, /cloneItems: cloneOrderingItems/);
  assert.match(dragHook, /snapshot: callbacksRef\.current\.cloneItems\(itemsRef\.current\)/);
  assert.match(dragHook, /getEdgeAutoScrollDelta/);
  assert.match(dragHook, /scrollBy\(\{ top: drag\.autoScrollDelta, behavior: 'auto' \}\)/);
  assert.match(dragHook, /requestAnimationFrame\(runAutoScroll\)/);
  assert.match(buttons, /aria-label=\{t\("上移一项"\)\}/);
  assert.match(buttons, /aria-label=\{t\("下移一项"\)\}/);
  assert.match(drawer, /aria-live="polite"/);
});

test('shelf order uses draft writes with conflict and retry-safe drafts', () => {
  const drawer = readSource('./AccountPlaylistDrawer.jsx');

  assert.doesNotMatch(drawer, /handleToggleVisibility/);
  assert.match(drawer, /preserveDraftOrder\(current, serverItems\)/);
  assert.match(drawer, /updateShelfOrder\(shelfDraftItems, shelfRevision\)/);
  assert.match(drawer, /if \(!shelfDirty \|\| shelfSaving/);
  assert.match(drawer, /唱片架已在其他位置更新。放弃当前排序并加载最新顺序吗/);
  assert.match(drawer, /status >= 500[\s\S]*草稿已保留，可以重试/);
  assert.match(drawer, /有尚未保存的调整，确认放弃并关闭吗/);
  assert.match(drawer, /registerBeforeClose\(beforeClose\)/);
  assert.match(drawer, /setIsOpen\(false\) === false/);
});

test('dirty account playlist closing uses one registered guard while identity cleanup is forced', () => {
  const drawer = readSource('./AccountPlaylistDrawer.jsx');
  const store = readSource('../store/useUIStore.js');
  const app = readSource('../app.jsx');

  assert.match(store, /registerAccountPlaylistBeforeClose/);
  assert.match(store, /accountPlaylistBeforeCloseGuard\?\.\(\) === false/);
  assert.match(store, /openLyricsWorkspace:[\s\S]*setIsAccountPlaylistOpen\(false\) === false/);
  assert.ok((store.match(/setIsAccountPlaylistOpen\(false\) === false/g) || []).length >= 5);
  assert.match(drawer, /setIsOpen\(false, \{ force: true \}\)/);
  assert.match(app, /\['isAccountPlaylistOpen', 'setIsAccountPlaylistOpen'\]/);
  assert.match(app, /if \(!closeTopOverlay\(state\)\)[\s\S]*history\.pushState\(\{ hermes_overlay: true \}/);
});

test('drawer focuses on shelf sorting while playlist detail view provides in-place editing and all-playlists provides skeleton creation', () => {
  const drawer = readSource('./AccountPlaylistDrawer.jsx');
  const detail = readSource('./PlaylistDetailView.jsx');
  const editor = readSource('../hooks/usePlaylistEditor.js');
  const allPlaylists = readSource('./AllPlaylistsView.jsx');

  assert.match(drawer, /歌单排序/);
  assert.match(drawer, /updateShelfOrder/);
  assert.doesNotMatch(drawer, /handleToggleVisibility/);
  assert.match(detail, /isPersonalPlaylist && \(/);
  assert.match(detail, /handleStartEdit/);
  assert.match(detail, /usePlaylistEditor/);
  assert.match(editor, /accountPlaylistsStore\.getState\(\)\.updatePlaylist/);
  assert.match(editor, /accountPlaylistsStore\.getState\(\)\.deletePlaylist/);
  assert.match(editor, /accountPlaylistsStore\.getState\(\)\.reorderSongs/);
  assert.match(allPlaylists, /record-card--create/);
  assert.match(allPlaylists, /accountPlaylistsStore\.getState\(\)\.createPlaylist/);
  assert.match(allPlaylists, /新建个人歌单/);
});

test('identity changes blank the workspace before close', () => {
  const drawer = readSource('./AccountPlaylistDrawer.jsx');

  assert.match(drawer, /workspaceSubject === subject/);
  assert.match(drawer, /identityRef\.current = \{ subject: nextSubject, epoch: identityRef\.current\.epoch \+ 1 \}/);
  assert.match(drawer, /token\.subject === identityRef\.current\.subject[\s\S]*token\.epoch === identityRef\.current\.epoch/);
  assert.match(drawer, /workspaceSubject && workspaceSubject !== subject/);
  assert.match(drawer, /if \(isOpen\) setIsOpen\(false, \{ force: true \}\)/);
  assert.match(drawer, /账号状态已变化，正在关闭管理抽屉/);
});
