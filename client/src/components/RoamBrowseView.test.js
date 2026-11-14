import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';
import { getPluginContribution, registerPluginContribution } from '../plugins/contributions.js';
import { formatPath } from '../utils/navigation.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : (node?.props?.children || []).flat(Infinity).map(text).join('');
const languages = ['zh', 'en', 'instrumental', 'ja', 'other', 'ko'];
function browse() {
  const navigations = [];
  const view = createBackgroundModuleHarness({ file: new URL('./RoamBrowseView.jsx', import.meta.url), modules: {
    '../i18n/index.js': { t: (key, params = {}) => key.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '') },
    ...Object.fromEntries(languages.map(key => [`../assets/categories/${key}.jpg`, `category:${key}`])),
    '../plugins/contributions.js': { usePluginContribution(id, slot, fallback) {
      assert.equal(id, 'roam'); assert.equal(slot, 'browse-header'); assert.equal(fallback, null);
      return getPluginContribution(id, slot) || fallback;
    } },
    '../utils/navigation.js': { formatPath, syncBrowserHistory: url => navigations.push(url) },
  } });
  return { ...view, navigations };
}

test('uninstalled roam keeps the original large heading and six browsable category cards', () => {
  const view = browse(), tree = view.render();
  assert.equal(tree.props.className, 'app-page roam-page pb-16');
  const heading = nodes(tree).find(node => node.type === 'h1');
  assert.equal(text(heading), '漫游'); assert.match(heading.props.className, /text-3xl sm:text-4xl/);
  const cards = nodes(tree).filter(node => node.type === 'button'); assert.equal(cards.length, 6);
  assert.deepEqual(nodes(tree).filter(node => node.type === 'img').map(node => node.props.src), languages.map(key => `category:${key}`));
  for (const card of cards) { assert.equal(card.props.disabled, undefined); card.props.onClick(); }
  assert.deepEqual(view.navigations, languages.map(key => `/explore/${key}`));
  assert.equal(nodes(tree).some(node => /私人电台/.test(text(node))), false);
  view.unmount();
});

test('the installed plugin contributes a React header above unchanged categories and uninstall removes only it', () => {
  const view = browse(); let directCalls = 0, current = true;
  const Radio = () => { directCalls++; return null; };
  const retire = registerPluginContribution('roam', 'browse-header', { isCurrent: () => current,
    getSnapshot: () => ({ renderers: { header: Radio } }) });
  try {
    const tree = view.render(), children = tree.props.children.flat(Infinity);
    assert.ok(children.findIndex(node => node?.type === Radio) < children.findIndex(node => node?.type === 'section'));
    assert.equal(nodes(tree).filter(node => node.type === Radio).length, 1);
    assert.equal(directCalls, 0, 'the host inserts a React component instead of invoking plugin rendering as an ordinary callback');
    assert.equal(nodes(tree).filter(node => node.type === 'button').length, 6);
    current = false;
    assert.equal(nodes(view.render()).some(node => node.type === Radio), false, 'a retired role/account lease cannot expose its header');
    retire();
    const after = view.render(); assert.equal(nodes(after).some(node => node.type === Radio), false);
    const cards = nodes(after).filter(node => node.type === 'button'); assert.equal(cards.length, 6);
    cards[0].props.onClick(); assert.equal(view.navigations.at(-1), '/explore/zh');
  } finally { retire(); view.unmount(); }
});
