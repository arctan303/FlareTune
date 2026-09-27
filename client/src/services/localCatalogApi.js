import { getApiBaseUrl } from './apiBase.js';
import { requestAccountJson } from './accountApiRequest.js';
import { useUIStore } from '../store/useUIStore.js';

class CatalogRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    Object.assign(this, details);
  }
}

export async function updateSongLanguage(songId, language, fetchImpl) {
  const session = useUIStore.getState().authSession;
  if (session?.user?.role !== 'admin' || !session.csrfToken) {
    throw new CatalogRequestError('需要管理员登录后才能编辑歌曲。', { status: 403 });
  }
  const path = `/api/admin/catalog/songs/${encodeURIComponent(songId)}`;
  const request = (init) => requestAccountJson({
    fetchImpl, base: getApiBaseUrl(), path, init,
    ErrorType: CatalogRequestError, errorLabel: '歌曲更新失败',
  });
  const current = await request();
  if (!current?.song?.version) throw new CatalogRequestError('歌曲版本不可用，请刷新后重试。');
  const updated = await request({ method: 'PUT', body: JSON.stringify({
    language, expectedVersion: current.song.version,
  }) });
  return updated.song;
}
