import test from 'node:test';
import assert from 'node:assert/strict';
import * as icons from 'lucide-react';
import { createBackgroundModuleHarness, createBackgroundScheduler } from '../test/fullscreenBackgroundHarness.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : (node?.props?.children || []).flat(Infinity).map(text).join('');
const t = (key, params = {}) => key.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');

function drawer() {
  const scheduler = createBackgroundScheduler();
  const song = { id: 'one', title: 'One', artist: 'Artist', audio_url: '/one.mp3' };
  const calls = [];
  const player = { playlist: [song], currentSong: song, isPlaying: true,
    clearPlaylist: () => calls.push('clear'), playSong: () => calls.push('play'),
    removePlaylistSong() {}, reorderPlaylist() {} };
  const roam = { available: false, enabled: false, status: 'idle', batchSize: 10,
    renderers: { footer: 'queue-contribution' }, actions: {
      toggleFromQueue() { if (roam.available) calls.push(['enabled', true]); },
      appendFromQueue() { if (roam.available) calls.push('append'); },
    } };
  const ui = { isPlaylistOpen: true, setIsPlaylistOpen() {}, isFullScreen: false, authSession: { authenticated: true } };
  const view = createBackgroundModuleHarness({ file: new URL('./PlaylistDrawer.jsx', import.meta.url), modules: {
    '../i18n/index.js': { t }, 'lucide-react': icons,
    '../store/usePlayerStore': { usePlayerStore: select => select(player) },
    '../store/useUIStore': { useUIStore: select => select(ui), showToast: value => calls.push(value) },
    '../plugins/contributions.js': { usePluginContribution: (_id, _slot, fallback) => roam.available ? roam : fallback },
    'zustand/react/shallow': { useShallow: value => value }, './QualityBadge': 'quality', './LazyImage': 'image',
    '../utils/queueScroll': { getCenteredQueueScrollTop: () => 0 },
    '../hooks/useVerticalReorderDrag.js': () => ({ dragState: null, clearDrag() {}, beginPointerDrag() {}, getRowStyle() {} }),
    './drawers/DrawerFrame': 'drawer', './drawers/useDrawerTransition': { useDrawerTransition: () => ({ mounted: true, visible: true }) },
  }, globals: { ...scheduler, document: { activeElement: null }, HTMLElement: class {}, window: { addEventListener() {}, removeEventListener() {} } } });
  return { ...view, player, roam, calls };
}

test('queue keeps normal play and clear controls while an uninstalled roam exposes no executable controls', () => {
  const view = drawer();
  const tree = view.render();
  const buttons = nodes(tree).filter(node => node.type === 'button');
  assert.equal(buttons.some(node => node.props.role === 'switch' || /漫游|补充/.test(text(node))), false);
  buttons.find(node => node.props['aria-label'] === '清空当前播放队列').props.onClick();
  assert.deepEqual(view.calls, ['clear']);
  assert.equal(view.player.currentSong.id, 'one');
  assert.equal(view.player.isPlaying, true);
  view.unmount();
});

test('installed roam queue controls delegate to its controller and disappear again on uninstall', () => {
  const view = drawer(); view.roam.available = true;
  let tree = view.render();
  nodes(tree).find(node => node.type === 'queue-contribution').props.actions.toggleFromQueue();
  nodes(tree).find(node => node.type === 'button' && text(node) === '漫游补充 10 首歌曲').props.onClick();
  assert.ok(view.calls.some(call => Array.isArray(call) && call[0] === 'enabled' && call[1] === true));
  assert.ok(view.calls.includes('append'));
  view.roam.available = false;
  tree = view.render();
  assert.equal(nodes(tree).some(node => node.type === 'queue-contribution'), false);
  assert.equal(view.player.playlist.length, 1);
  assert.equal(view.player.isPlaying, true);
  view.unmount();
});

test('empty queues offer roam only after installation', () => {
  const view = drawer(); view.player.playlist = []; view.player.currentSong = null;
  assert.equal(nodes(view.render()).some(node => node.type === 'button' && /开启随机漫游/.test(text(node))), false);
  view.roam.available = true;
  const start = nodes(view.render()).find(node => node.type === 'button' && /开启随机漫游/.test(text(node)));
  assert.ok(start); start.props.onClick(); assert.ok(view.calls.includes('append'));
  view.unmount();
});
