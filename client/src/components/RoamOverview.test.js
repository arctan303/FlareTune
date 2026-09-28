import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('RoamOverview embeds console, inline settings, and library categories without drawer wrappers', () => {
  const roam = readSource('./RoamOverview.jsx');

  // 内嵌漫游控制台与启停主按钮
  assert.match(roam, /随心漫游电台/);
  assert.match(roam, /onToggleRoam/);
  assert.match(roam, /randomRoam\.enabled/);
  assert.match(roam, /开启漫游电台/);
  assert.match(roam, /暂停漫游/);

  // 内嵌语种范围多选与快捷键
  assert.match(roam, /ROAM_LANGUAGES/);
  assert.match(roam, /漫游语种范围/);
  assert.match(roam, /handleToggleKey/);
  assert.match(roam, /handleSelectAll/);
  assert.match(roam, /handleSelectOnlyZh/);
  assert.match(roam, /setRandomRoamLanguage/);

  // 内嵌单次补充数量
  assert.match(roam, /ROAM_BATCH_SIZE_OPTIONS/);
  assert.match(roam, /单次补充数量/);
  assert.match(roam, /handleBatchSizeChange/);
  assert.match(roam, /setRandomRoamBatchSize/);

  // 内嵌去重记录管理
  assert.match(roam, /近期去重：20%/);
  assert.doesNotMatch(roam, /handleResetHistory/);

  // 内嵌曲库分类探索
  assert.match(roam, /曲库探索/);
  assert.match(roam, /onOpenLanguage/);
  assert.match(roam, /items\.map/);

  // 彻底解耦侧边栏抽屉，不使用抽屉包装
  assert.doesNotMatch(roam, /DrawerFrame/);
  assert.doesNotMatch(roam, /useDrawerTransition/);
  assert.doesNotMatch(roam, /labelledBy="roam-settings-drawer-title"/);
});
