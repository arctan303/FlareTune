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

test('PlaylistDrawer integrates pointer drag reordering, grip handles, auto-scrolling and store actions', () => {
  const drawer = readSource('./PlaylistDrawer.jsx');
  const dragHook = readSource('../hooks/useVerticalReorderDrag.js');
  const dragLifecycle = readSource('../hooks/usePointerDragLifecycle.js');
  const css = readSource('../styles/drawers.css');

  // 1. 验证拖拽入口接入共享状态机
  assert.match(drawer, /GripVertical/);
  assert.match(drawer, /useVerticalReorderDrag/);
  assert.match(dragHook, /getEdgeAutoScrollDelta/);

  // 2. 验证 store 解构了 reorderPlaylist
  assert.match(drawer, /reorderPlaylist/);

  // 3. 验证拖拽手柄、Pointer Events 与防冲突绑定
  assert.match(drawer, /beginPointerDrag/);
  assert.match(dragHook, /movePointerDrag/);
  assert.match(dragHook, /finishPointerDrag/);
  assert.match(dragHook, /setPointerCapture/);
  assert.match(dragLifecycle, /releasePointerCapture/);
  assert.match(drawer, /className="queue-row__drag/);
  assert.match(drawer, /aria-label=\{`按住拖拽调整 \$\{song\.title\} 排序`\}/);

  // 4. 验证边缘自动滚动与边界防溢出
  assert.match(dragHook, /runAutoScroll/);
  assert.match(dragHook, /scrollBy\(\{ top: drag\.autoScrollDelta, behavior: 'auto' \}\)/);
  assert.match(dragHook, /requestAnimationFrame\(runAutoScroll\)/);
  assert.match(dragHook, /minSlotOffsetY/);
  assert.match(dragHook, /maxSlotOffsetY/);
  assert.match(dragHook, /previousScrollTop === currentScrollTop/);

  // 5. 验证拖拽与吸附样式
  assert.match(drawer, /is-drag-active/);
  assert.match(dragHook, /translate3d\(0, \$\{dragState\.offsetY\}px, 0\)/);
  assert.match(css, /\.queue-row__drag\s*\{[\s\S]*?cursor:\s*grab/);
  assert.match(css, /\.queue-row\.is-drag-active\s*\{/);
});
