import {
  AccountPlayStatsError,
  getTopPlayedSongs,
  recordSongPlays,
} from '../services/accountPlayStats.js';

export const accountPlayStatsJson = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  },
});

export async function handleAccountPlayStatsRoute(request, url, db, headers, user) {
  if (!user?.subject) {
    return accountPlayStatsJson({ ok: false, error: 'AUTH_REQUIRED', message: '需要登录账号才能访问播放统计。' }, 401, headers);
  }

  const expectedSubject = request.headers.get('X-Arc-Account-Subject') || '';
  if (!expectedSubject || expectedSubject !== user.subject) {
    return accountPlayStatsJson({
      ok: false,
      error: 'IDENTITY_CHANGED',
      message: '账号身份已经变化，请刷新后重试。',
    }, 409, headers);
  }

  try {
    if (request.method === 'GET') {
      const limitParam = url.searchParams.get('limit');
      const data = await getTopPlayedSongs(db, user.subject, limitParam || 20);
      return accountPlayStatsJson({ ok: true, data }, 200, headers);
    }

    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return accountPlayStatsJson({ ok: false, error: 'INVALID_BODY', message: '请求体必须是有效 JSON。' }, 400, headers);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return accountPlayStatsJson({ ok: false, error: 'INVALID_BODY', message: '请求体必须是对象。' }, 400, headers);
      }
      const data = await recordSongPlays(db, user.subject, body.events);
      return accountPlayStatsJson({ ok: true, data }, 200, headers);
    }

    return accountPlayStatsJson({ ok: false, error: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法。' }, 405, headers);
  } catch (error) {
    if (error instanceof AccountPlayStatsError) {
      return accountPlayStatsJson({ ok: false, error: error.code, message: error.message }, error.status, headers);
    }
    console.error('[account-play-stats] 存储处理异常:', error);
    return accountPlayStatsJson({ ok: false, error: 'MUSIC_STORAGE_UNAVAILABLE', message: '播放统计存储暂时不可用。' }, 503, headers);
  }
}
