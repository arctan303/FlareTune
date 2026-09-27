/**
 * IndexedDB 存储工具：专门用于持久化存储本地自定义壁纸大图二进制 (Blob)
 * 避免 Base64 塞满 localStorage (5MB 限制) 导致 QuotaExceededError
 */

const DB_NAME = 'music_wallpaper_db';
const DB_VERSION = 1;
const STORE_NAME = 'wallpapers';
const LOCAL_WALLPAPER_KEY = 'custom_local_wallpaper';

// 内存回退（在无 IndexedDB 的测试或 SSR 环境中使用）
let memoryStore = new Map();

const isIndexedDBSupported = () => {
  return typeof window !== 'undefined' && Boolean(window.indexedDB);
};

const openDatabase = () => {
  if (!isIndexedDBSupported()) {
    return Promise.reject(new Error('IndexedDB is not supported in current environment'));
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = () => {
      reject(request.error || new Error('Failed to open wallpaper IndexedDB'));
    };
  });
};

/**
 * 保存本地壁纸 Blob 到 IndexedDB
 * @param {Blob} blob 
 * @param {{ name?: string, type?: string, size?: number }} metadata 
 * @returns {Promise<{ ok: boolean, durable: boolean, reason?: string, error?: unknown }>}
 */
export async function saveLocalWallpaperBlob(blob, metadata = {}) {
  if (!blob) return { ok: false, durable: false, reason: 'missing-blob' };

  const record = {
    blob,
    name: metadata.name || 'custom-wallpaper',
    type: metadata.type || blob.type || 'image/jpeg',
    size: metadata.size || blob.size || 0,
    updatedAt: Date.now(),
  };

  if (!isIndexedDBSupported()) {
    memoryStore.set(LOCAL_WALLPAPER_KEY, record);
    return { ok: true, durable: false, reason: 'indexeddb-unavailable' };
  }

  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record, LOCAL_WALLPAPER_KEY);

      let requestError = null;

      req.onerror = () => {
        requestError = req.error || new Error('Failed to save wallpaper blob');
      };
      tx.oncomplete = () => {
        db.close();
        resolve({ ok: true, durable: true });
      };
      tx.onerror = () => {
        requestError = requestError || tx.error || new Error('Failed to save wallpaper transaction');
      };
      tx.onabort = () => {
        db.close();
        reject(requestError || tx.error || new Error('Wallpaper save transaction was aborted'));
      };
    });
  } catch (error) {
    console.warn('[wallpaperDb] 写入 IndexedDB 失败，回退至内存:', error);
    memoryStore.set(LOCAL_WALLPAPER_KEY, record);
    return { ok: true, durable: false, reason: 'indexeddb-write-failed', error };
  }
}

/**
 * 从 IndexedDB 读取本地壁纸
 * @returns {Promise<{ blob: Blob, name: string, type: string, size: number } | null>}
 */
export async function getLocalWallpaperBlob() {
  if (!isIndexedDBSupported()) {
    const record = memoryStore.get(LOCAL_WALLPAPER_KEY);
    return record ? { ...record, persistence: 'volatile' } : null;
  }

  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(LOCAL_WALLPAPER_KEY);

      req.onsuccess = () => {
        const result = req.result || null;
        resolve(result ? { ...result, persistence: 'durable' } : null);
      };
      req.onerror = () => reject(req.error || new Error('Failed to read wallpaper blob'));
      tx.oncomplete = () => db.close();
    });
  } catch (error) {
    console.warn('[wallpaperDb] 读取 IndexedDB 失败，回退至内存:', error);
    const record = memoryStore.get(LOCAL_WALLPAPER_KEY);
    return record ? { ...record, persistence: 'volatile' } : null;
  }
}

/**
 * 清除已持久化的本地壁纸
 * @returns {Promise<{ ok: boolean, durable: boolean, reason?: string, error?: unknown }>}
 */
export async function deleteLocalWallpaperBlob() {
  if (!isIndexedDBSupported()) {
    memoryStore.delete(LOCAL_WALLPAPER_KEY);
    return { ok: true, durable: false, reason: 'indexeddb-unavailable' };
  }

  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(LOCAL_WALLPAPER_KEY);

      let requestError = null;

      req.onerror = () => {
        requestError = req.error || new Error('Failed to delete wallpaper blob');
      };
      tx.oncomplete = () => {
        memoryStore.delete(LOCAL_WALLPAPER_KEY);
        db.close();
        resolve({ ok: true, durable: true });
      };
      tx.onerror = () => {
        requestError = requestError || tx.error || new Error('Failed to delete wallpaper transaction');
      };
      tx.onabort = () => {
        db.close();
        reject(requestError || tx.error || new Error('Wallpaper delete transaction was aborted'));
      };
    });
  } catch (error) {
    console.warn('[wallpaperDb] 删除 IndexedDB 壁纸失败:', error);
    return { ok: false, durable: true, reason: 'indexeddb-delete-failed', error };
  }
}

export function _clearMemoryStoreForTest() {
  memoryStore.clear();
}
