import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../../test/fullscreenBackgroundHarness.js';
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes)] : [];
const translate = (value, args = {}) => value.replace(/\{(\w+)\}/gu, (_, key) => args[key] ?? '');
const fixture = () => createBackgroundModuleHarness({ file: new URL('./SearchTrackRow.jsx', import.meta.url), exportName: 'SearchTrackRow',
  modules: {
    '../../utils/musicSource.js': { isYouTubeEntity: song => song.source === 'youtube', canReferenceAccountSong: () => true },
    '../../i18n/index.js': { t: translate }, 'lucide-react': { MoreHorizontal: 'more', Check: 'check' },
    '../LazyImage': 'image', '../catalog/SongActionsMenu.jsx': 'menu', './HighlightText': { HighlightText: 'highlight' },
    '../../constants/language': { getLanguageShortLabel: () => '' }, '../../utils/songType': { resolveSongLanguage: () => null },
  }, globals: {} });

test('search renders the provider display title while play and selection receive the untouched song', () => {
  const h = fixture(), calls = [], song = Object.freeze({ id: 'yt:3yaab2_EEHM', source: 'youtube',
    title: '愛♡スクリ～ム！ - AI SCREAM!', displayTitle: '愛♡スクリ～ム！', artist: 'AiScReam' });
  const songs = [song];
  const props = { song, songs, onPlay: (...args) => calls.push(args), onToggleBulkSelection: (...args) => calls.push(args) };
  let all = nodes(h.render(props));
  assert.equal(all.find(n => n.type === 'highlight').props.text, song.displayTitle);
  const play = all.find(n => n.props?.className === 'track-row__main-action');
  assert.ok(play.props['aria-label'].includes(song.displayTitle));
  assert.ok(!play.props['aria-label'].includes('AI SCREAM!'));
  play.props.onClick({}); assert.equal(calls[0][0], song); assert.equal(calls[0][1], songs);
  all = nodes(h.render({ ...props, isBulkSelecting: true }));
  all.find(n => n.props?.className === 'track-row__main-action').props.onClick({});
  assert.equal(calls[1][0], song); assert.equal(song.title, '愛♡スクリ～ム！ - AI SCREAM!');
  h.unmount();
});

test('missing or empty display names fall back and local songs retain their title', () => {
  const h = fixture();
  for (const song of [{ source: 'youtube', displayTitle: '' }, { source: 'youtube', displayTitle: '  ' },
    { source: 'youtube' }, { source: 'local', displayTitle: 'Should not replace' }]) {
    const all = nodes(h.render({ song: { id: 'one', title: 'Original', ...song }, songs: [] }));
    assert.equal(all.find(n => n.type === 'highlight').props.text, 'Original');
  }
  h.unmount();
});
