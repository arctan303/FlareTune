import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

const setup = (name, recoverable) => {
  const requests = [];
  const harness = createBackgroundModuleHarness({ file: new URL('./useCatalogPage.js', import.meta.url), exportName: 'useCatalogPage',
    modules: { '../services/catalogRead.js': { readCatalog: (_type, options) => new Promise((resolve, reject) => requests.push({ options, resolve, reject })) },
      '../services/apiBase.js': { getApiBaseUrl: () => name } }, globals: { AbortController },
    render: (exports, props) => exports.useCatalogPage('artists', props) });
  harness.render({ query: 'artist', recoverable });
  return { harness, requests };
};

test('recoverable catalog retries a failed first request and preserves rows and cursor after a failed next page', async () => {
  const { harness, requests } = setup('recovery-page', true);
  requests[0].reject(new Error('offline')); await flushBackgroundAsync();
  let page = harness.render(); assert.equal(page.status, 'error'); assert.equal(page.requestError, 'refresh');
  page.retry(); page = harness.render(); assert.equal(page.status, 'loading');
  requests[1].resolve({ items: [{ id: 'one' }], hasMore: true, nextOffset: 47 }); await flushBackgroundAsync();
  page = harness.render(); const more = page.loadMore();
  requests[2].reject(new Error('offline')); await more; page = harness.render();
  assert.equal(page.requestError, 'more'); assert.equal(page.items[0].id, 'one'); assert.equal(page.nextOffset, 47);
  const retried = page.loadMore(); assert.equal(requests[3].options.offset, 47);
  requests[3].resolve({ items: [{ id: 'two' }], hasMore: false, nextOffset: 48 }); await retried;
  page = harness.render(); assert.deepEqual(Array.from(page.items, item => item.id), ['one', 'two']); assert.equal(page.requestError, null);
  page.retry(); page = harness.render(); assert.equal(page.status, 'ready'); assert.equal(page.items.length, 2); assert.equal(page.refreshing, true);
  requests[4].reject(new Error('offline')); await flushBackgroundAsync(); page = harness.render();
  assert.equal(page.status, 'ready'); assert.equal(page.items.length, 2); assert.equal(page.requestError, 'refresh');
  harness.unmount();
});

test('recoverable refresh and pagination cannot race to replace a newly read first page', async () => {
  const { harness, requests } = setup('refresh-page-race', true);
  requests[0].resolve({ items: [{ id: 'old-first' }], hasMore: true, nextOffset: 20 }); await flushBackgroundAsync();
  harness.render().retry(); let page = harness.render();
  requests[1].reject(new Error('offline')); await flushBackgroundAsync();
  page = harness.render(); assert.equal(page.items[0].id, 'old-first');
  page.retry(); page = harness.render(); assert.equal(page.refreshing, true);
  const blockedPage = page.loadMore();
  assert.equal(requests.length, 3, 'a refresh must finish before its cursor is used for pagination');
  await blockedPage;
  requests[2].resolve({ items: [{ id: 'new-first' }], hasMore: true, nextOffset: 47 }); await flushBackgroundAsync();
  page = harness.render(); const more = page.loadMore();
  assert.equal(requests[3].options.offset, 47, 'use the refreshed cursor, not the old snapshot');
  requests[3].resolve({ items: [{ id: 'new-second' }], hasMore: false, nextOffset: 48 }); await more;
  assert.deepEqual(Array.from(harness.render().items, item => item.id), ['new-first', 'new-second']);
  harness.unmount();
});

test('legacy category callers keep their registered silent next-page behavior', async () => {
  const { harness, requests } = setup('legacy-page', false);
  requests[0].resolve({ items: [{ id: 'one' }], hasMore: true, nextOffset: 20 }); await flushBackgroundAsync();
  const more = harness.render().loadMore(); requests[1].reject(new Error('offline')); await more;
  const page = harness.render(); assert.equal(page.status, 'ready'); assert.equal(page.items.length, 1); assert.equal(page.requestError, null);
  harness.unmount();
});
