import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./PlayerControls.jsx', import.meta.url), 'utf8');

test('classic metadata aligns XiaoA and more actions with the title row', () => {
  const titleRow = source.indexOf('classic-controls__title-row');
  const title = source.indexOf("currentSong?.id + '-title'", titleRow);
  const actions = source.indexOf('classic-controls__metadata-actions', titleRow);
  const moreMenu = source.indexOf('<PlayerMoreMenu', actions);
  const artistAlbum = source.indexOf("currentSong?.id + '-meta'", moreMenu);

  assert.ok(titleRow >= 0, 'title row must be explicit');
  assert.ok(title > titleRow, 'title must render in the title row');
  assert.ok(actions > title, 'actions must share the title row after the title');
  assert.ok(moreMenu > actions, 'more menu must stay in the title actions');
  assert.ok(artistAlbum > moreMenu, 'artist and album must render on their own following row');
  assert.match(source, /containerClassName="flex-1 min-w-0"/);
});
