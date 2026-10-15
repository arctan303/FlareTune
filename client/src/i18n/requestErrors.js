import english from './en.js';

const requestLabels = new Set([
  '歌词请求失败', '个人歌单请求失败', '入库设备操作失败',
  '曲库操作失败', '获取播放统计失败', '提交播放统计失败',
]);
const commonErrors = {
  SONG_NOT_FOUND: '未找到歌曲', PLAYLIST_NOT_FOUND: '歌单不存在。',
  UNAUTHORIZED: '登录会话已失效，请重新登录。',
  DATABASE_UNAVAILABLE: '数据库暂时不可用，请稍后重试。',
  METHOD_NOT_ALLOWED: '此操作暂不支持。',
};
const lyricErrors = {
  FORBIDDEN: '只有管理员可以修改共享歌词。',
  LYRIC_INSPECTION_UNAVAILABLE: '候选预览失败。',
  LYRIC_AI_CONFIG_UNAVAILABLE: '歌词 AI 尚未配置。',
  INVALID_LYRIC_ASSET: '歌词文件无效，请重新获取或导入。',
  LYRIC_STORAGE_UNAVAILABLE: '歌词存储暂时不可用，请重试。',
  LYRIC_CANDIDATE_INVALID: '所选歌词候选不可用，请重新搜索。',
  LYRIC_SOURCE_UNAVAILABLE: '歌词源加载失败，请重试。',
  LYRIC_SOURCES_UNAVAILABLE: '歌词源加载失败，请重试。',
  LYRICS_NOT_NEEDED: '纯音乐无需歌词。',
  LYRIC_AI_DISABLED: '歌词 AI 已关闭',
  LYRIC_ASSET_NOT_FOUND: '尚未保存歌词文件。',
  LYRIC_ASSET_CONFLICT: '歌词已在别处更新，请重新载入后重试。',
  LYRIC_AI_FAILED: '歌词翻译补全失败，可以点击重试',
  LYRIC_WORKSPACE_UNAVAILABLE: '歌词请求失败',
};
const invalidLyricCodes = new Set([
  'INVALID_SONG_ID', 'INVALID_QUERY', 'INVALID_LYRIC_CANDIDATES', 'INVALID_LYRIC_UPDATE',
  'INVALID_LYRIC_IMPORT', 'INVALID_LYRIC_RESTORE', 'INVALID_LYRIC_DOCUMENT',
  'INVALID_LYRIC_DRAFT_RECEIPT', 'INVALID_LYRIC_DRAFT', 'INVALID_LYRIC_OFFSET',
  'INVALID_TRANSLATION_RESET', 'INVALID_LYRIC_RESET', 'INVALID_AI_COMPLETION',
]);
export const REQUEST_ERROR_KEYS = Object.freeze([...new Set([
  ...requestLabels, ...Object.values(commonErrors), ...Object.values(lyricErrors),
  '歌词请求参数无效，请检查后重试。', '{label}（{status}）', '{label}（{status}）：{detail}',
])]);

// Keep stored errors locale-neutral. Existing consumers retain Error.message;
// t() decodes the bounded fallback format only when displaying it.
export function requestErrorSource(payload, label, status) {
  if (typeof payload?.message === 'string' && Object.hasOwn(english, payload.message)) return payload.message;
  const code = typeof payload?.error === 'string' ? payload.error : '';
  const source = label === '歌词请求失败'
    ? (Object.hasOwn(lyricErrors, code) ? lyricErrors[code] : null)
      || (invalidLyricCodes.has(code) ? '歌词请求参数无效，请检查后重试。' : null)
    : null;
  if (source || Object.hasOwn(commonErrors, code)) return source || commonErrors[code];
  return `${label}（${status}）${typeof payload?.message === 'string' && payload.message ? `：${payload.message}` : ''}`;
}

export function decodeRequestError(source) {
  if (typeof source !== 'string') return null;
  const match = source.match(/^([^（）]+)（(\d{3})）(?:：([\s\S]+))?$/u);
  if (!match || !requestLabels.has(match[1])) return null;
  return { source: match[3] ? '{label}（{status}）：{detail}' : '{label}（{status}）',
    label: match[1], status: match[2], detail: match[3] };
}
