import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';
const session = { authenticated: true, user: { accountId: 'A' } };
const noop = () => {};

test('song menu keeps its owner mounted when opening the speaker dialog, then dismisses on close', () => {
  let closed = 0;
  const icons = Object.fromEntries(['FolderPlus', 'ListPlus', 'Pencil', 'Puzzle', 'Star', 'Trash2'].map((name) => [name, name]));
  const pluginMenu = { entries: [{ pluginId: 'fixture', id: 'output', label: '音箱输出' }], selection: null,
    open(entry) { this.selection = { entry, context: { slot: 'menu.song', song: { id: 'song-1' } } }; } };
  const harness = createBackgroundModuleHarness({
    file: new URL('./catalog/SongActionsMenu.jsx', import.meta.url),
    modules: {
      '../../i18n/index.js': { t: (text) => text }, 'lucide-react': icons,
      '../../store/useUIStore.js': { useUIStore: (selector) => selector({ authSession: session }) },
      '../../hooks/usePluginMenu.js': { usePluginMenu: () => pluginMenu },
      './FloatingTrackMenu.jsx': 'floating-menu', '../PluginActionDialog.jsx': 'speaker-output',
    }, globals: { window: { addEventListener: noop, removeEventListener: noop } },
  });
  const song = { id: 'song-1', title: 'Track' };
  const props = { song, anchorRef: { current: { focus: noop } }, onClose: () => closed++ };
  const menu = harness.render(props);
  const entry = menu.props.children.flat(Infinity).find((element) => element?.props?.children?.some((child) => child?.props?.children?.includes('音箱输出')));
  assert.ok(entry, 'speaker action is available to signed-in users');
  entry.props.onClick({ stopPropagation: noop });
  assert.equal(closed, 0, 'opening the dialog cannot unmount its menu owner');
  const dialog = harness.render(props);
  assert.equal(dialog.type, 'speaker-output');
  assert.equal(dialog.props.selection.context.song.id, 'song-1');
  assert.equal(dialog.props.song, undefined, 'opening output settings never selects or casts the menu song');
  dialog.props.onClose();
  assert.equal(closed, 1);
  harness.unmount();
});
