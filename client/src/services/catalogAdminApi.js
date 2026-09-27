import { getApiBaseUrl } from './apiBase.js';
import { authenticatedFetch } from './authenticatedFetch.js';
import { requestAccountJson } from './accountApiRequest.js';
import { useUIStore } from '../store/useUIStore.js';
import { notifyAuthenticationRequired } from '../authNavigation.js';

export class CatalogAdminError extends Error {
  constructor(message, details = {}) {
    super(message);
    Object.assign(this, details);
  }
}

const catalog = (path, init, fetchImpl) => requestAccountJson({
  base: getApiBaseUrl(), path: `/api/admin/catalog/${path}`, init,
  fetchImpl, ErrorType: CatalogAdminError, errorLabel: '曲库操作失败',
});

const body = (value) => JSON.stringify(value);
const mediaTypes = Object.freeze({
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', wma: 'audio/x-ms-wma',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
});
export const listCatalogSongs = ({ page = 1, q = '' } = {}, fetchImpl) =>
  catalog(`songs?page=${page}&limit=30&q=${encodeURIComponent(q)}`, {}, fetchImpl);
export const getCatalogSong = (id, fetchImpl) => catalog(`songs/${encodeURIComponent(id)}`, {}, fetchImpl);
export const createCatalogSong = (value, fetchImpl) => catalog('songs', { method: 'POST', body: body(value) }, fetchImpl);
export const updateCatalogSong = (id, value, fetchImpl) =>
  catalog(`songs/${encodeURIComponent(id)}`, { method: 'PUT', body: body(value) }, fetchImpl);
export const deleteCatalogSong = (id, expectedVersion, fetchImpl) =>
  catalog(`songs/${encodeURIComponent(id)}`, { method: 'DELETE', body: body({ expectedVersion, confirmDelete: true }) }, fetchImpl);

function uploadWithProgress(url, init, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(init.method, url);
    request.withCredentials = true;
    for (const [name, value] of Object.entries(init.headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    request.onload = () => {
      notifyAuthenticationRequired({ status: request.status });
      let payload = {};
      try { payload = JSON.parse(request.responseText); } catch { /* Handled below. */ }
      if (request.status < 200 || request.status >= 300 || payload?.ok !== true) {
        reject(new CatalogAdminError(payload?.message || `媒体上传失败（${request.status}）`,
          { status: request.status, code: payload?.error }));
        return;
      }
      resolve(payload.data);
    };
    request.onerror = () => reject(new CatalogAdminError('网络连接中断，媒体上传失败。'));
    request.onabort = () => reject(new CatalogAdminError('媒体上传已中止。'));
    request.send(init.body);
  });
}

export async function uploadCatalogMedia(kind, file, fetchImpl, onProgress) {
  if (!['audio', 'cover'].includes(kind) || !(file instanceof File) || !file.size) {
    throw new CatalogAdminError('请选择非空音频或封面文件。');
  }
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  if (!extension || !mediaTypes[extension]
    || (kind === 'audio' ? !mediaTypes[extension].startsWith('audio/') : !mediaTypes[extension].startsWith('image/'))) {
    throw new CatalogAdminError('不支持该媒体格式。');
  }
  const id = [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const session = useUIStore.getState().authSession;
  if (session?.user?.role !== 'admin' || !session.csrfToken) throw new CatalogAdminError('需要管理员登录。', { status: 403 });
  const url = `${getApiBaseUrl()}/api/admin/catalog/media/${kind}/${id}.${extension}`;
  const init = {
    method: 'PUT', credentials: 'include', cache: 'no-store', body: file,
    headers: {
      'Content-Type': mediaTypes[extension],
      'X-FlareTune-Media-Size': String(file.size),
      'X-Requested-With': 'FlareTune',
      'X-CSRF-Token': session.csrfToken,
      'X-FlareTune-Expected-Account': session.user.accountId,
    },
  };
  if (onProgress && typeof XMLHttpRequest === 'function' && !fetchImpl) {
    return uploadWithProgress(url, init, onProgress);
  }
  const response = await authenticatedFetch(url, init, fetchImpl);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) {
    throw new CatalogAdminError(payload?.message || `媒体上传失败（${response.status}）`,
      { status: response.status, code: payload?.error });
  }
  return payload.data;
}
