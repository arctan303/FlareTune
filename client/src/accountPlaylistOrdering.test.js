import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneOrderingItems, getEdgeAutoScrollDelta, isOrderingDirty, moveOrderingItem,
  moveOrderingItemBy, preserveDraftOrder, resolveVisibleShelfPlaylists, typedPlaylistRefKey } from './accountPlaylistOrdering.js';

const shelf = [
  { kind: 'member', id: 'favorite' },
  { kind: 'member', id: 'first' },
  { kind: 'member', id: 'last' },
];

test('account shelf ignores legacy system refs and always includes personal favorites', () => {
  const members = [
    { id: 'favorite', kind: 'favorite', name: '我喜欢' },
    { id: 'first', kind: 'regular', name: '第一张' },
    { id: 'last', kind: 'regular', name: '第二张' },
  ];
  assert.deepEqual(resolveVisibleShelfPlaylists({ memberPlaylists: members, authenticated: false }), []);
  assert.deepEqual(resolveVisibleShelfPlaylists({ memberPlaylists: members, authenticated: true, shelf: null }).map((p) => p.id),
    ['favorite', 'first', 'last']);
  assert.deepEqual(resolveVisibleShelfPlaylists({ memberPlaylists: members, authenticated: true,
    shelf: { items: [{ kind: 'system', id: 'legacy' }, { kind: 'member', id: 'last' }, { kind: 'member', id: 'first' }] } }).map((p) => p.id),
  ['favorite', 'last', 'first']);
});

test('member playlist ordering supports pointer and button moves', () => {
  assert.equal(typedPlaylistRefKey(shelf[0]), 'member:favorite');
  assert.deepEqual(moveOrderingItem(shelf, 'member:last', 0).map(typedPlaylistRefKey),
    ['member:last', 'member:favorite', 'member:first']);
  assert.deepEqual(moveOrderingItemBy(shelf, 'member:last', -1).map(typedPlaylistRefKey),
    ['member:favorite', 'member:last', 'member:first']);
});

test('dirty comparison tracks order and cloning protects the base snapshot', () => {
  const base = cloneOrderingItems(shelf);
  const moved = moveOrderingItemBy(base, 'member:first', 1);
  assert.equal(isOrderingDirty(base, moved), true);
  assert.equal(isOrderingDirty(base, cloneOrderingItems(base)), false);
  assert.deepEqual(base, shelf);
});

test('server changes preserve unsaved personal order while adding a new playlist', () => {
  const draft = moveOrderingItem(shelf, 'member:last', 0);
  const server = [...shelf, { kind: 'member', id: 'new' }];
  assert.deepEqual(preserveDraftOrder(draft, server).map(typedPlaylistRefKey),
    ['member:last', 'member:favorite', 'member:first', 'member:new']);
});

test('pointer cancel restores the immutable pre-drag snapshot', () => {
  const snapshot = cloneOrderingItems(shelf);
  assert.notDeepEqual(moveOrderingItem(snapshot, 'member:favorite', 2), snapshot);
  assert.deepEqual(cloneOrderingItems(snapshot), shelf);
});

test('edge auto-scroll is directional, bounded and idle away from edges', () => {
  assert.equal(getEdgeAutoScrollDelta(110, 100, 500), -15);
  assert.equal(getEdgeAutoScrollDelta(490, 100, 500), 15);
  assert.equal(getEdgeAutoScrollDelta(300, 100, 500), 0);
  assert.equal(getEdgeAutoScrollDelta(-100, 100, 500), -18);
});
