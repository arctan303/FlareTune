import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceDemoStorage} from './storageNamespace.js';
test('demo namespaces owned preference/history/database keys without replacing arbitrary names',()=>{
  const code="const a='musicPlayer_ui', b=\"music-play-history-v2\", c='arc_recent_searches', d='arc-player-context', e='theme_pref', f='music_wallpaper_db', other='unrelated';";
  const next=namespaceDemoStorage(code);
  for(const key of ['musicPlayer_ui','music-play-history-v2','arc_recent_searches','arc-player-context','theme_pref','music_wallpaper_db']) assert.ok(next.includes(`flaretune-demo:v1:${key}`));
  assert.ok(next.includes("other='unrelated'")); assert.equal(namespaceDemoStorage(next),next);
});
