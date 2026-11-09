import { canReferenceAccountSong } from '../../utils/musicSource.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getMobileLyricWindow, getPrimaryLyricLine, getTranslationLyricLine } from './mobileLyricPreview.js';
import { useLyricSurfacePresentation } from '../lyrics/lyricSurfacePresentation.js';
import { lyricPlaybackClock } from '../../services/lyricPlaybackClock.js';

// Execute the actual JSX component. Neighbouring controls/artwork are stubs so
// this focused render test needs neither browser globals nor store fixtures.
let renderedLyricLines = 0;
const empty = () => null;
const dependencies = {
  react: React,
  '../../i18n/index.js': { t: (text) => text, localizeUnknownArtist: (text) => text, localizeUnknownTitle: (text) => text },
  'lucide-react': { Star: empty },
  '../LazyImage.jsx': empty,
  '../LyricsScroller.jsx': empty,
  '../PlayerControls.jsx': empty,
  '../PlayerMoreMenu.jsx': empty,
  '../../utils/musicSource.js': { canReferenceAccountSong },
  '../../hooks/useFavoriteSongAction.js': { useFavoriteSongAction: () => ({ isFavorite: () => false, pendingSongIds: new Set(), justAddedSongIds: new Set(), toggleFavorite() {}, clearAddedAnimation() {} }) },
  './mobileLyricPreview.js': { getMobileLyricWindow, getPrimaryLyricLine, getTranslationLyricLine },
  '../lyrics/SyncedLyricText.jsx': ({ text }) => {
    renderedLyricLines += 1;
    return React.createElement('span', null, text);
  },
  '../lyrics/lyricSurfacePresentation.js': {
    useLyricSurfacePresentation,
  },
  './ClassicArtwork.jsx': empty,
};
const compiled = transformSync(readFileSync(new URL('./MobileClassicPanes.jsx', import.meta.url), 'utf8'), {
  loader: 'jsx', format: 'cjs', jsx: 'transform',
}).code;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)((name) => {
  assert.ok(Object.hasOwn(dependencies, name), `unhandled component dependency: ${name}`);
  return dependencies[name];
}, module, module.exports);
const { MobileSongPane, MobileLyricsPane } = module.exports;
const lyrics = [
  { time: 0, text: 'First line', translation: '第一行' },
  { time: 3, text: 'Second line', translation: '第二行' },
  { time: 6, text: 'Third line', translation: '第三行' },
];
const renderPane = (overrides = {}) => {
  renderedLyricLines = 0;
  return renderToStaticMarkup(React.createElement(MobileSongPane, {
    canShowLyrics: true, hasValidLyrics: true, currentLyricIndex: 1,
    isMobile: true, lyrics, translationEnabled: true, ...overrides,
  }));
};

test('desktop song pane does not mount the mobile lyric projection', () => {
  const markup = renderPane({ isMobile: false, surfaceVisible: false });
  assert.equal(renderedLyricLines, 0);
  assert.doesNotMatch(markup, /First line|Second line|第一行|paper-mobile-lyric-preview/);
});

test('mobile song pane preserves full preview rows, translations and active-row positioning', () => {
  const markup = renderPane();
  assert.equal(renderedLyricLines, 3);
  assert.match(markup, /First line/);
  assert.match(markup, /第三行/);
  assert.match(markup, /paper-mobile-lyric-preview__row is-active[^>]*>.*?Second line/);
  assert.match(markup, /translateY\(-45px\)/);
  const untranslated = renderPane({ translationEnabled: false });
  assert.equal(renderedLyricLines, 3);
  assert.doesNotMatch(untranslated, /第一行|第二行|第三行/);
  assert.match(untranslated, /translateY\(-26px\)/);
});

test('mobile unavailable and instrumental states still omit the lyric preview', () => {
  renderPane({ hasValidLyrics: false });
  assert.equal(renderedLyricLines, 0);
  renderPane({ canShowLyrics: false });
  assert.equal(renderedLyricLines, 0);
});

test('mobile prelude preview preserves the first two original rows and first translation', () => {
  const preludeLyrics = [
    { time: 12, text: '『はい喜んで』', translation: '乐意效劳',
      words: [{ text: '『はい喜んで』', startTime: 12, endTime: 13 }] },
    { time: 14, text: '『あなた方のため』' },
  ];
  const audio = { currentTime: 0, paused: true, duration: 120, playbackRate: 1,
    addEventListener() {}, removeEventListener() {} };
  lyricPlaybackClock.attach(audio);
  try {
    for (const currentTime of [0, 10, 11.999, 12, 0]) {
      audio.currentTime = currentTime;
      lyricPlaybackClock.sample('seeked');
      const markup = renderPane({ lyrics: preludeLyrics, currentLyricIndex: 0, lyricSyncMode: 'word',
        lyricIntro: { time: 0, text: 'こっちのけんと - はいよろこんで' } });
      assert.ok(markup.includes(preludeLyrics[0].text));
      assert.ok(markup.includes(preludeLyrics[1].text));
      assert.ok(markup.includes('乐意效劳'));
      assert.ok(!markup.includes('こっちのけんと - はいよろこんで'));
    }
  } finally {
    lyricPlaybackClock.detach();
  }
});

test('long mobile lyrics mount at most seven nearby rows without changing the full roller height', () => {
  const longLyrics = Array.from({ length: 100 }, (_, index) => ({ time: index * 3,
    text: `lyric-${index}`, translation: `translation-${index}` }));
  const markup = renderPane({ lyrics: longLyrics, currentLyricIndex: 50 });
  assert.equal(renderedLyricLines, 7);
  assert.match(markup, /lyric-47/);
  assert.match(markup, /lyric-53/);
  assert.doesNotMatch(markup, /lyric-46|lyric-54/);
  assert.match(markup, /height:2914px/);
  assert.match(markup, /height:2852px/);
  assert.match(markup, /translateY\(-3083px\)/);
  renderPane({ lyrics: longLyrics, currentLyricIndex: 0 });
  assert.equal(renderedLyricLines, 4);
  renderPane({ lyrics: longLyrics, currentLyricIndex: 99 });
  assert.equal(renderedLyricLines, 4);
});


test('mobile lyrics controls expose account-library favorite for both local and YouTube songs', () => {
  const render=currentSong=>renderToStaticMarkup(React.createElement(MobileLyricsPane,{
    currentSong,controlsVisible:true,coverUrl:'/placeholder-album.svg',playerControlsProps:{},lyricsScrollerProps:{},
  }));
  assert.match(render({id:'local',title:'Local'}),/加入我的收藏/);
  assert.match(render({id:'yt:QBtVFL0Qefs',source:'youtube',title:'YT'}),/加入我的收藏/);
});
