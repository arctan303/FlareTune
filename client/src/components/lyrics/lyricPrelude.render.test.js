import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import React from 'react';
import { Languages } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { lyricPlaybackClock } from '../../services/lyricPlaybackClock.js';
import { useLyricSurfacePresentation } from './lyricSurfacePresentation.js';
import * as interlude from '../../utils/interludeState.js';
import * as keyboard from '../lyricKeyboardNavigation.js';
import * as motion from '../classicLyricMotion.js';
import { getPlayerBarLyricLayout } from '../../utils/playerBarLyrics.js';

// Execute the real row renderers, presentation hook and interlude host. Static
// markup verifies content and visibility gates; it does not verify CSS motion.
const serverReact = { ...React, useLayoutEffect: React.useEffect };
const empty = () => null;
const plainText = ({ text, children }) => React.createElement('span', null, text ?? children);
function component(path, dependencies) {
  const compiled = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'jsx', format: 'cjs', jsx: 'transform',
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (name === 'react') return serverReact;
    assert.ok(Object.hasOwn(dependencies, name), `unhandled dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports.default;
}
const InterludeHost = component('./InterludeHost.jsx', {
  '../../services/lyricPlaybackClock': { lyricPlaybackClock },
  '../../utils/interludeState': interlude,
  './InterludeDots': () => React.createElement('span', null, 'interlude-dots'),
});
const LyricsScroller = component('../LyricsScroller.jsx', {
  '../i18n/index.js': { t: (text) => text },
  '../hooks/usePlaybackVolume.js': { usePlaybackVolume: ({ volume }) => ({ volume, setVolume() {}, toggleMute() {} }) },
  'lucide-react': { VolumeX: empty, Volume2: empty, Loader2: empty, Languages },
  './lyrics/InterludeHost': InterludeHost,
  './lyrics/SyncedLyricText': plainText,
  './lyrics/lyricSurfacePresentation.js': { useLyricSurfacePresentation },
  './lyricKeyboardNavigation.js': keyboard,
  '../hooks/usePlayerAutoHide.js': { usePlayerInteractionLock: empty },
  './classicLyricMotion.js': motion,
});
const PlayerBarLyricPreview = component('../playerbar/PlayerBarLyricPreview.jsx', {
  '../../utils/playerBarLyrics.js': { getPlayerBarLyricLayout },
  '../QualityBadge.jsx': empty,
  './ScrollingText.jsx': plainText,
  '../lyrics/SyncedLyricText.jsx': plainText,
  '../lyrics/lyricSurfacePresentation.js': { useLyricSurfacePresentation },
});
const song = { id: 'prelude-regression', artist: 'こっちのけんと', title: 'はいよろこんで' };
const lyricsAt = (start, syncMode) => [
  { time: start, text: '『はい喜んで』', translation: '乐意效劳',
    ...(syncMode === 'word' ? { words: [{ text: '『はい喜んで』', startTime: start, endTime: start + 1 }] } : {}) },
  { time: start + 2, text: '『あなた方のため』', translation: '为了各位' },
];
const audio = { currentTime: 0, duration: 120, paused: true, playbackRate: 1,
  addEventListener() {}, removeEventListener() {} };

for (const syncMode of ['line', 'word']) {
  for (const start of [4.5, 12]) {
    test(`${syncMode} rows with a ${start}s prelude retain first lyrics in external and fullscreen players`, () => {
      const lyrics = lyricsAt(start, syncMode);
      lyricPlaybackClock.attach(audio);
      try {
        for (const currentTime of [0, start - 2, start - 0.001, start, 0]) {
          audio.currentTime = currentTime;
          lyricPlaybackClock.sample('seeked');
          const props = { lyrics, currentLyricIndex: 0, lyricSyncMode: syncMode,
            currentSong: song, translationEnabled: true, canTranslate: true,
            lyricIntro: { time: 0, text: `${song.artist} - ${song.title}` },
            title: song.title, subtitle: song.artist, isPlaying: false,
            audioRef: { current: audio }, volume: 0.8, isFullScreen: true };
          const external = renderToStaticMarkup(React.createElement(PlayerBarLyricPreview, props));
          const fullscreen = renderToStaticMarkup(React.createElement(LyricsScroller, props));
          for (const markup of [external, fullscreen]) {
            assert.ok(markup.includes(lyrics[0].text), `first lyric at ${currentTime}`);
            assert.ok(markup.includes(lyrics[1].text), `second lyric at ${currentTime}`);
            assert.ok(markup.includes('乐意效劳'), `first translation at ${currentTime}`);
            assert.ok(!markup.includes(`${song.artist} - ${song.title}`));
          }
          if (currentTime >= start - 2) {
            assert.match(fullscreen, /classic-lyrics__text-wrap[^>]*opacity:1/);
          } else if (start >= 12) {
            // A long prelude still shows the indicator before the first line.
            assert.match(fullscreen, /classic-lyrics__text-wrap[^>]*opacity:0/, `indicator at ${currentTime}`);
          }
        }
      } finally {
        lyricPlaybackClock.detach();
      }
    });
  }
}

test('the fullscreen translation action shows only the shared 14px Languages icon in every state', () => {
  for (const translationState of ['ready', 'missing', 'pending', 'failed']) {
    const markup = renderToStaticMarkup(React.createElement(LyricsScroller, {
      lyrics: lyricsAt(4.5, 'line'), currentLyricIndex: 0, lyricSyncMode: 'line', currentSong: song,
      translationEnabled: true, canTranslate: true, translationState,
      audioRef: { current: audio }, volume: 0.8, isFullScreen: true }));
    const button = markup.match(/<button[^>]*lyrics-translation-action[^>]*>([\s\S]*?)<\/button>/);
    assert.ok(button, translationState);
    for (const attribute of ['lucide-languages', 'width="14"', 'height="14"', 'stroke-width="1.75"',
      'aria-hidden="true"', 'focusable="false"']) assert.ok(button[1].includes(attribute), `${translationState}: ${attribute}`);
    assert.equal(button[1].replace(/<[^>]+>/g, '').trim(), '', `${translationState}: no visible glyph text`);
    assert.match(button[0], /aria-label="[^"]+"/);
    assert.equal(/\sdisabled=""/.test(button[0]), translationState === 'pending');
  }
});

test('a single synchronized lyric stays visible and no-lyrics placeholders keep the metadata view', () => {
  for (const syncMode of ['line', 'word', 'none']) {
    const markup = renderToStaticMarkup(React.createElement(PlayerBarLyricPreview, {
      lyrics: syncMode === 'none' ? [{ time: 0, text: '暂无歌词' }] : lyricsAt(12, syncMode).slice(0, 1),
      currentLyricIndex: 0, lyricSyncMode: syncMode, title: 'Song title', subtitle: 'Artist',
    }));
    if (syncMode === 'none') {
      assert.match(markup, /Song title/);
      assert.doesNotMatch(markup, /暂无歌词/);
    } else {
      assert.ok(markup.includes('『はい喜んで』'));
      assert.doesNotMatch(markup, /Song title/);
    }
  }
});
