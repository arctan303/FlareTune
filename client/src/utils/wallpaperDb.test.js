import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveLocalWallpaperBlob,
  getLocalWallpaperBlob,
  deleteLocalWallpaperBlob,
  _clearMemoryStoreForTest,
} from './wallpaperDb.js';

test('wallpaperDb stores, retrieves and deletes blob in memory fallback mode', async () => {
  _clearMemoryStoreForTest();

  // Initially empty
  const initial = await getLocalWallpaperBlob();
  assert.equal(initial, null);

  // Save blob
  const mockBlob = { size: 2048, type: 'image/png' };
  const saved = await saveLocalWallpaperBlob(mockBlob, {
    name: 'custom-art.png',
    size: 2048,
    type: 'image/png',
  });
  assert.deepEqual(saved, {
    ok: true,
    durable: false,
    reason: 'indexeddb-unavailable',
  });

  // Retrieve blob
  const retrieved = await getLocalWallpaperBlob();
  assert.notEqual(retrieved, null);
  assert.equal(retrieved.name, 'custom-art.png');
  assert.equal(retrieved.size, 2048);
  assert.equal(retrieved.blob, mockBlob);

  // Delete blob
  const deleted = await deleteLocalWallpaperBlob();
  assert.deepEqual(deleted, {
    ok: true,
    durable: false,
    reason: 'indexeddb-unavailable',
  });

  const afterDelete = await getLocalWallpaperBlob();
  assert.equal(afterDelete, null);
});

const createFailingIndexedDb = () => ({
  open() {
    const request = {};
    queueMicrotask(() => {
      const db = {
        objectStoreNames: { contains: () => true },
        close() {},
        transaction() {
          const tx = {
            error: new Error('forced transaction failure'),
            objectStore() {
              return {
                put() {
                  const operation = {};
                  queueMicrotask(() => {
                    operation.error = tx.error;
                    operation.onerror?.();
                    tx.onerror?.();
                    tx.onabort?.();
                  });
                  return operation;
                },
                delete() {
                  const operation = {};
                  queueMicrotask(() => {
                    operation.error = tx.error;
                    operation.onerror?.();
                    tx.onerror?.();
                    tx.onabort?.();
                  });
                  return operation;
                },
                get() {
                  const operation = {};
                  queueMicrotask(() => {
                    operation.error = tx.error;
                    operation.onerror?.();
                    tx.onerror?.();
                    tx.onabort?.();
                  });
                  return operation;
                },
              };
            },
          };
          return tx;
        },
      };
      request.result = db;
      request.onsuccess?.({ target: request });
    });
    return request;
  },
});

const createDeferredIndexedDb = () => {
  let transaction = null;
  return {
    indexedDB: {
      open() {
        const request = {};
        queueMicrotask(() => {
          const db = {
            objectStoreNames: { contains: () => true },
            close() {},
            transaction() {
              transaction = {
                error: null,
                objectStore: () => ({
                  put() {
                    const operation = {};
                    queueMicrotask(() => operation.onsuccess?.());
                    return operation;
                  },
                }),
              };
              return transaction;
            },
          };
          request.result = db;
          request.onsuccess?.({ target: request });
        });
        return request;
      },
    },
    complete() {
      transaction?.oncomplete?.();
    },
  };
};

test('wallpaperDb reports durable save only after the IndexedDB transaction completes', async () => {
  const originalWindow = globalThis.window;
  const deferred = createDeferredIndexedDb();
  globalThis.window = { indexedDB: deferred.indexedDB };
  let settled = false;

  try {
    const savePromise = saveLocalWallpaperBlob({ size: 1, type: 'image/png' })
      .then((result) => {
        settled = true;
        return result;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    deferred.complete();
    assert.deepEqual(await savePromise, { ok: true, durable: true });
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('wallpaperDb reports volatile fallback and preserves it when durable deletion fails', async () => {
  _clearMemoryStoreForTest();
  const originalWindow = globalThis.window;
  globalThis.window = { indexedDB: createFailingIndexedDb() };

  try {
    const mockBlob = { size: 10, type: 'image/png' };
    const saved = await saveLocalWallpaperBlob(mockBlob, { name: 'volatile.png' });
    assert.equal(saved.ok, true);
    assert.equal(saved.durable, false);
    assert.equal(saved.reason, 'indexeddb-write-failed');

    const deleted = await deleteLocalWallpaperBlob();
    assert.equal(deleted.ok, false);
    assert.equal(deleted.reason, 'indexeddb-delete-failed');

    const retained = await getLocalWallpaperBlob();
    assert.equal(retained?.name, 'volatile.png');
    assert.equal(retained?.persistence, 'volatile');
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    _clearMemoryStoreForTest();
  }
});
