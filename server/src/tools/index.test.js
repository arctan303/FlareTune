import test from 'node:test';
import assert from 'node:assert/strict';
import { getToolProgressText } from './index.js';

test('tool progress text is natural, deterministic, and only exposes cleaned display targets', () => {
  assert.equal(
    getToolProgressText('music_query', { action: 'search', keyword: '《青涩果实》' }),
    '我去曲库里找一下《青涩果实》。',
  );
  assert.equal(getToolProgressText('music_query', { action: 'random' }), '我从曲库里挑几首。');
  assert.equal(getToolProgressText('music_control', { action: 'play_song', song_id: 'private-id' }), '我准备一下这首歌。');
  assert.equal(getToolProgressText('my_listening_stats', { limit: 5 }), '我看看你的收听统计。');
  assert.equal(getToolProgressText('roam_control', { action: 'disable' }), '我准备关闭随机漫游。');
  assert.equal(getToolProgressText('roam_control', { action: 'enable', language: 'zh' }), '我准备开启随机漫游。');
  assert.equal(getToolProgressText('current_time', { timezone: 'Asia/Singapore' }), '我确认一下当前时间。');
  assert.equal(getToolProgressText('manage_playlist', { action: 'read', playlist_id: 'private-list' }), '我看看你的歌单。');
  assert.equal(getToolProgressText('player_queue', { song_ids: ['private-song'] }), '我准备调整一下播放队列。');
  assert.equal(getToolProgressText('player_seek', { position: 42 }), '我准备调整一下播放进度。');
  const hostile = getToolProgressText('music_query', {
    action: 'search',
    keyword: '青涩\n[果实](https://internal.example)<script>'.repeat(10),
  });
  assert.doesNotMatch(hostile, /[\r\n\[\]()<>]|https|script/);
  assert.ok(Array.from(hostile).length < 60);
  assert.doesNotMatch(getToolProgressText('unknown_tool', { secret: 'must-not-leak' }), /must-not-leak|unknown_tool/);

  const variants = new Set(Array.from({ length: 24 }, (_, index) => getToolProgressText(
    'music_query',
    { action: 'search', keyword: '青涩果实' },
    `call-${index}`,
  )));
  assert.ok(variants.size >= 4);
  assert.equal(
    getToolProgressText('music_query', { action: 'search', keyword: '青涩果实' }, 'stable-call'),
    getToolProgressText('music_query', { action: 'search', keyword: '青涩果实' }, 'stable-call'),
  );
});
