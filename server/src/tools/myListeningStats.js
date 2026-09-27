import { getTopPlayedSongs } from '../services/accountPlayStats.js';
import { normalizeSong } from './songDto.js';
import { createToolResult, createToolFailure } from './toolResult.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const resolveLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

export const myListeningStatsTool = {
  name: 'my_listening_stats',
  displayName: '我的收听统计',
  description: '读取当前登录听众本人的收听统计：播放次数最多的歌曲及各自播放次数、累计播放次数与曲目数。只能访问当前会话用户自己的数据，需要登录。',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: '返回的歌曲数量，默认 20，最大 50。',
      },
    },
  },
  async execute(args, context = {}) {
    const db = context?.db;
    const subject = context?.user?.subject;
    if (!db || typeof db.prepare !== 'function') {
      return createToolFailure({
        modelText: '播放统计存储当前不可用，请稍后再试。',
        summary: '播放统计存储不可用',
        type: 'music_cards',
        code: 'database_unavailable',
        message: 'music database binding is unavailable',
        data: { songs: [] },
      });
    }
    if (!subject) {
      return createToolFailure({
        modelText: '收听统计只对登录听众开放，请先登录后再问。',
        summary: '需要登录账号',
        type: 'music_cards',
        code: 'auth_required',
        message: 'listener is not signed in',
        data: { songs: [] },
      });
    }

    try {
      const { songs: rows, totalPlays, totalUniqueSongs } = await getTopPlayedSongs(
        db,
        subject,
        resolveLimit(args?.limit),
      );
      const songs = rows.map(normalizeSong);
      const playCounts = rows.map((row) => Number(row.play_count) || 0);
      const modelText = songs.length === 0
        ? '这位听众目前还没有可用的收听记录。'
        : [
            `这是该听众播放次数最多的 ${songs.length} 首歌：`,
            ...songs.map((song, index) => `${index + 1}. 《${song.title}》 - ${song.artist}（播放 ${playCounts[index]} 次）`),
            `累计播放 ${totalPlays} 次，共 ${totalUniqueSongs} 首曲目。`,
          ].join('\n');

      return createToolResult({
        modelText,
        summary: songs.length > 0
          ? `读到 ${songs.length} 首收听最多的歌曲`
          : '暂无收听记录',
        eventData: {
          ok: true,
          type: 'music_cards',
          songs,
          total_plays: totalPlays,
          total_unique_songs: totalUniqueSongs,
        },
        playerAction: null,
      });
    } catch (error) {
      console.error('my_listening_stats failed:', error);
      return createToolFailure({
        modelText: '收听统计查询失败，请稍后再试。',
        summary: '收听统计查询失败',
        type: 'music_cards',
        code: 'database_query_failed',
        message: error?.message || String(error),
        data: { songs: [] },
      });
    }
  },
};
