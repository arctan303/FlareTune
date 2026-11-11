import { readBoundedJson } from '../instance/httpSecurity.js';
import { readLyricsFromChain, verifyLyricResultRef, lyricSourceOrderSettings } from '../services/lyricSourceChain.js';
import { resolveLyricSong } from '../services/playbackLyrics.js';
import { computeHash } from '../utils/lyricsParsing.js';

const messages = {
  zh: ['歌词结果已更新，请重新加载。', '没有权限执行此操作。', '歌词服务暂不可用。'],
  'zh-Hant': ['歌詞結果已更新，請重新載入。', '沒有權限執行此操作。', '歌詞服務暫時無法使用。'],
  en: ['The lyric result changed. Reload the lyrics.', 'You do not have permission to perform this action.', 'Lyrics are temporarily unavailable.'],
  ja: ['歌詞が更新されました。再読み込みしてください。', 'この操作を行う権限がありません。', '歌詞サービスを一時的に利用できません。'],
  ko: ['가사가 변경되었습니다. 다시 불러오세요.', '이 작업을 수행할 권한이 없습니다.', '가사 서비스를 일시적으로 사용할 수 없습니다.'],
};
export const lyricRouteErrorMessage = (status, locale = 'en') => {
  const language = /^zh-(?:Hant|TW|HK)/iu.test(locale) ? 'zh-Hant' : String(locale).split('-')[0];
  return (messages[language] || messages.en)[status === 409 ? 0 : status === 403 ? 1 : 2];
};

export async function handleLyricSourceRoute(request, url, env, session, executionContext, deps = {}) {
  if (!['/api/lyrics/translation', '/api/lyrics/sources/order'].includes(url.pathname)) return null;
  deps = { ...deps, locale: request.headers.get('Accept-Language')?.split(',')[0] };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } });
  try {
    if (url.pathname.endsWith('/order')) {
      if (!['GET', 'PUT'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
      const update = request.method === 'PUT' ? await readBoundedJson(request, 8192) : undefined;
      if (update && (Object.keys(update).some(key => !['order', 'expectedRevision'].includes(key))
        || !Array.isArray(update.order))) return json({ error: 'invalid_input' }, 400);
      return json(await lyricSourceOrderSettings({ env, session, executionContext, deps, update }));
    }
    if (request.method !== 'POST') return json({ code: 405, message: 'Method not allowed' }, 405);
    const body = await readBoundedJson(request, 12288);
    if (!body || Object.keys(body).some(key => key !== 'resultRef') || typeof body.resultRef !== 'string') return json({ code: 400, message: 'Invalid lyric result' }, 400);
    const ref = await verifyLyricResultRef(env, body.resultRef, { accountId: session?.account?.accountId,
      sessionHash: await computeHash(session?.tokenHash || '') });
    const song = await resolveLyricSong(env.DB, ref.songId, deps);
    if (!song) return json({ code: 404, message: 'Song not found', reason: 'song_not_found' }, 404);
    const read = await readLyricsFromChain({ env, session, song, executionContext, signal: request.signal,
      resultRef: body.resultRef, translate: true, deps });
    return json({ code: 200, data: read.lyrics });
  } catch (error) {
    const status = error?.status >= 400 && error.status <= 599 ? error.status : error?.name === 'RequestBodyError' ? 400 : 503;
    return json({ code: status, error: /^[A-Za-z0-9_]{1,100}$/u.test(error?.code || '') ? error.code : 'LYRIC_SERVICE_UNAVAILABLE',
      message: lyricRouteErrorMessage(status, deps.locale) }, status);
  }
}
