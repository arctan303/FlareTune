import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../../test/fullscreenBackgroundHarness.js';

const flatten = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(flatten)] : [];
test('catalog states distinguish cold loading, failure, empty and retained results with the correct retry action', () => {
  const harness = createBackgroundModuleHarness({ file: new URL('./CatalogReadState.jsx', import.meta.url),
    modules: { '../../i18n/index.js': { t: value => value }, './CatalogSkeleton.jsx': 'skeleton' }, globals: {} });
  let retries = 0, pages = 0;
  const resource = { items: [], status: 'loading', retry: () => retries++, loadMore: () => pages++ };
  let tree = harness.render({ resource, type: 'artists', emptyLabel: 'empty', children: 'rows' });
  assert.equal(flatten(tree).some(node => node.type === 'skeleton'), true);
  tree = harness.render({ resource: { ...resource, status: 'error' }, type: 'artists', emptyLabel: 'empty' });
  assert.equal(flatten(tree).some(node => node.props?.role === 'alert'), true);
  assert.equal(JSON.stringify(tree).includes('empty'), false);
  flatten(tree).find(node => node.type === 'button').props.onClick(); assert.equal(retries, 1);
  tree = harness.render({ resource: { ...resource, status: 'ready', items: [{ id: 1 }], requestError: 'more' }, type: 'artists', children: 'rows' });
  assert.equal(JSON.stringify(tree).includes('rows'), true);
  flatten(tree).find(node => node.type === 'button').props.onClick(); assert.equal(pages, 1);
  tree = harness.render({ resource: { ...resource, status: 'ready' }, type: 'artists', emptyLabel: 'empty' });
  assert.equal(JSON.stringify(tree).includes('empty'), true); assert.equal(flatten(tree).some(node => node.props?.role === 'alert'), false);
  harness.unmount();
});
