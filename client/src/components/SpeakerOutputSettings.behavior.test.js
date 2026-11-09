import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, createBackgroundScheduler } from '../test/fullscreenBackgroundHarness.js';

const noop = () => {};
const owner = { authenticated: true, user: { accountId: 'A' }, csrfToken: 'csrf-A' };
const device = { id: 'd1', name: 'Living room', hardware: 'L05B', supported: true };
const find = (element, type) => {
  if (!element || typeof element !== 'object') return undefined;
  if (element.type === type) return element;
  return element.props?.children?.flat(Infinity).map(child => find(child, type)).find(Boolean);
};
const findRole = (element, role) => {
  if (!element || typeof element !== 'object') return undefined;
  if (element.props?.role === role) return element;
  return element.props?.children?.flat(Infinity).map(child => findRole(child, role)).find(Boolean);
};
test('player menu opens speaker output without a current song and restores focus when it closes', () => {
  const scheduler = createBackgroundScheduler();
  let focused = 0;
  const icons = Object.fromEntries(['FolderPlus', 'MoreHorizontal', 'Pencil', 'Languages', 'Puzzle'].map(name => [name, name]));
  const pluginMenu = { entries: [{ pluginId: 'fixture', id: 'output', label: '音箱输出' }], selection: null,
    open(entry) { this.selection = { entry, context: { slot: 'menu.player' } }; }, close() { this.selection = null; } };
  const harness = createBackgroundModuleHarness({
    file: new URL('./PlayerMoreMenu.jsx', import.meta.url),
    modules: {
      '../i18n/index.js': { t: text => text }, 'lucide-react': icons,
      '../store/useUIStore': { useUIStore: selector => selector({ authSession: owner }) },
      '../store/usePlayerStore': { usePlayerStore: selector => selector({ currentSong: null }) },
      '../hooks/usePluginMenu.js': { usePluginMenu: () => pluginMenu },
      '../hooks/usePluginAvailable.js': { usePluginAvailable: () => false },
      './PlayerModeChoices.jsx': 'modes', './PluginActionDialog.jsx': 'output-dialog',
      '../hooks/usePlayerMenu.js': { usePlayerMenu: ({ setIsOpen }) => ({ closeMenu: () => setIsOpen(false), menuProps: {} }) },
    }, globals: { ...scheduler }, nodes: { button: { focus: () => focused++ } },
  });
  let view = harness.render({});
  find(view, 'button').props.onClick();
  view = harness.render({});
  const menu = findRole(view, 'menu');
  assert.ok(menu);
  assert.doesNotMatch(JSON.stringify(menu), /歌词工作台/, 'an uninstalled lyrics plugin exposes no menu action');
  const outputEntry = menu.props.children.flat(Infinity).find(entry => entry?.type === 'button');
  assert.ok(outputEntry, 'the output action exists when no track is selected');
  outputEntry.props.onClick();
  view = harness.render({});
  const dialog = find(view, 'output-dialog');
  assert.ok(dialog);
  assert.equal(dialog.props.selection.context.slot, 'menu.player');
  assert.equal(dialog.props.song, undefined);
  dialog.props.onClose();
  assert.equal(focused, 1);
  harness.unmount();
});
