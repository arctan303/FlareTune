import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (path) => {
  const url = new URL(path, import.meta.url);
  return readFileSync(url, 'utf8');
};

test('PlaylistDrawer integrates text-only manual roam trigger action at queue end', () => {
  const drawer = readSource('./PlaylistDrawer.jsx');

  // 1. 验证引入 Loader2 和 triggerManualRandomRoam，不再使用 Sparkles 图标
  assert.match(drawer, /Loader2/);
  assert.doesNotMatch(drawer, /Sparkles/);
  assert.match(drawer, /triggerManualRandomRoam/);

  // 2. 验证 handleManualRoamAppend 逻辑
  assert.match(drawer, /handleManualRoamAppend/);
  assert.match(drawer, /请先登录后体验漫游功能/);
  assert.match(drawer, /t\("正在补充 \{p0\} 首漫游歌曲…", \{ p0: \(randomRoam\.batchSize \|\| 10\) \}\)/);

  // 3. 验证漫游开关旁不再放置补充按钮（已移除）
  assert.doesNotMatch(drawer, /<span>补充歌曲<\/span>/);

  // 4. 验证列表末尾补充歌曲按钮与空列表开启漫游为纯文本按钮（无图标）
  assert.match(drawer, /正在补充漫游歌曲…/);
  assert.match(drawer, /t\("漫游补充 \{p0\} 首歌曲", \{ p0: \(randomRoam\.batchSize \|\| 10\) \}\)/);
  assert.match(drawer, /t\("开启随机漫游 \(\{p0\} 首\)", \{ p0: \(randomRoam\.batchSize \|\| 10\) \}\)/);
  assert.match(drawer, /disabled=\{randomRoam\.status === 'loading'\}/);
});
