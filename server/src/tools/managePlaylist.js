import {
  AccountPlaylistError,
  addSongsToPlaylists,
  clearPlaylistSongs,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  replacePlaylistSongs,
  updatePlaylist,
} from '../services/accountPlaylists.js';
import { createToolResult } from './toolResult.js';

const services = {
  addSongsToPlaylists,
  clearPlaylistSongs,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  replacePlaylistSongs,
  updatePlaylist,
};

const result = (data, summary) => createToolResult({
  modelText: JSON.stringify(data),
  summary,
  eventData: data,
});

const failed = (error) => ({
  ok: false,
  outcome: 'failed',
  error: error instanceof AccountPlaylistError ? error.code : (error?.message === 'MUSIC_STORAGE_UNAVAILABLE' ? error.message : 'MUSIC_STORAGE_UNAVAILABLE'),
  message: error instanceof AccountPlaylistError ? error.message : '个人歌单存储暂时不可用。',
  ...(error instanceof AccountPlaylistError && error.data !== undefined ? { data: error.data } : {}),
});

const requireSongIds = (value) => {
  if (!Array.isArray(value)) throw new AccountPlaylistError('INVALID_BODY', 'song_ids 必须是数组。');
  return value;
};

const resolveSongIds = async (db, rawSongIds) => {
  if (!Array.isArray(rawSongIds)) return rawSongIds;
  if (!db || typeof db.prepare !== 'function') return rawSongIds;
  const resolved = [];
  for (const rawId of rawSongIds) {
    const str = typeof rawId === 'string' ? rawId.trim() : String(rawId || '').trim();
    if (!str) continue;
    try {
      const direct = await db.prepare('SELECT id FROM Songs WHERE id = ?').bind(str).first();
      if (direct) {
        resolved.push(String(direct.id));
        continue;
      }
      const cleanTitle = str.replace(/^《|》$/g, '').trim().toLowerCase();
      if (cleanTitle) {
        const byTitle = await db.prepare(
          'SELECT id FROM Songs WHERE LOWER(title) = ? OR LOWER(title) LIKE ? LIMIT 1',
        ).bind(cleanTitle, `%${cleanTitle}%`).first();
        if (byTitle) {
          resolved.push(String(byTitle.id));
          continue;
        }
      }
    } catch {}
    resolved.push(str);
  }
  return resolved;
};

const resolveExpectedRevision = async (service, db, subject, playlistId, providedRevision) => {
  if (typeof providedRevision === 'number' && Number.isInteger(providedRevision) && providedRevision >= 0) {
    return providedRevision;
  }
  const current = await service.getPlaylist(db, subject, playlistId);
  return Number(current?.revision ?? 0);
};

export async function executeManagePlaylist(args = {}, context = {}, service = services) {
  const subject = context.user?.subject;
  if (!subject) {
    return result({
      ok: false,
      outcome: 'failed',
      error: 'AUTH_REQUIRED',
      message: '需要登录账号才能管理个人歌单。',
    }, '需要登录账号才能管理个人歌单');
  }

  const db = context.db;
  const action = String(args.action || '');
  try {
    if (action === 'list') {
      const data = await service.listPlaylists(db, subject);
      return result({ ok: true, action, ...data }, `读取了 ${data.playlists.length} 个个人歌单`);
    }
    if (action === 'read') {
      const playlist = await service.getPlaylist(db, subject, args.playlist_id);
      return result({ ok: true, action, playlist }, `读取歌单《${playlist.name}》`);
    }
    if (action === 'create') {
      const data = await service.createPlaylist(
        db,
        subject,
        { name: args.name, description: args.description },
        undefined,
        { idempotencyKey: context.toolCallId },
      );
      const outcome = data.outcome || 'applied';
      const output = {
        ok: true,
        action,
        ...data,
        outcome,
        affectedPlaylistIds: outcome === 'applied' ? [data.playlist.id] : [],
      };
      return result(output, outcome === 'noop' ? `同一操作此前已创建歌单《${data.playlist.name}》，无需重复创建` : `已创建歌单《${data.playlist.name}》`);
    }
    if (action === 'add_songs') {
      const revision = await resolveExpectedRevision(service, db, subject, args.playlist_id, args.expected_revision);
      const songIds = await resolveSongIds(db, requireSongIds(args.song_ids));
      const data = await service.addSongsToPlaylists(db, subject, {
        targets: [{ playlistId: args.playlist_id, expectedRevision: revision }],
        songIds,
      });
      const playlist = await service.getPlaylist(db, subject, args.playlist_id);
      const output = { ok: data.outcome !== 'failed', action, ...data, playlist };
      return result(output, data.outcome === 'noop' ? '目标歌曲已在歌单中' : '个人歌单加歌已处理');
    }
    if (action === 'remove_songs') {
      const current = await service.getPlaylist(db, subject, args.playlist_id);
      const revision = await resolveExpectedRevision(service, db, subject, args.playlist_id, args.expected_revision);
      const removed = new Set((await resolveSongIds(db, requireSongIds(args.song_ids))).map(String));
      const songIds = current.songs.map((song) => String(song.id)).filter((id) => !removed.has(id));
      const data = await service.replacePlaylistSongs(db, subject, args.playlist_id, songIds, revision);
      const output = { ok: true, action, ...data, affectedPlaylistIds: data.outcome === 'applied' ? [args.playlist_id] : [] };
      return result(output, data.outcome === 'noop' ? '歌单中没有这些歌曲' : '已从个人歌单移除歌曲');
    }
    if (action === 'clear') {
      const revision = await resolveExpectedRevision(service, db, subject, args.playlist_id, args.expected_revision);
      const data = await service.clearPlaylistSongs(db, subject, args.playlist_id, revision);
      const output = { ok: true, action, ...data, affectedPlaylistIds: data.outcome === 'applied' ? [args.playlist_id] : [] };
      return result(output, data.outcome === 'noop' ? '歌单已经为空' : '已清空个人歌单');
    }
    if (action === 'replace_songs') {
      const revision = await resolveExpectedRevision(service, db, subject, args.playlist_id, args.expected_revision);
      const songIds = await resolveSongIds(db, requireSongIds(args.song_ids));
      const data = await service.replacePlaylistSongs(db, subject, args.playlist_id, songIds, revision);
      const output = { ok: true, action, ...data, affectedPlaylistIds: data.outcome === 'applied' ? [args.playlist_id] : [] };
      return result(output, data.outcome === 'noop' ? '歌单已经是目标内容' : '已替换个人歌单歌曲');
    }
    if (action === 'reorder_songs') {
      const current = await service.getPlaylist(db, subject, args.playlist_id);
      const revision = await resolveExpectedRevision(service, db, subject, args.playlist_id, args.expected_revision);
      const resolvedSongIds = await resolveSongIds(db, requireSongIds(args.song_ids));
      const songIds = resolvedSongIds.map(String);
      const currentIds = current.songs.map((song) => String(song.id));
      if (songIds.length !== currentIds.length || new Set(songIds).size !== songIds.length || songIds.some((id) => !currentIds.includes(id))) {
        throw new AccountPlaylistError('INVALID_BODY', 'song_ids 必须是当前歌曲 ID 的完整排列。');
      }
      const data = await service.replacePlaylistSongs(db, subject, args.playlist_id, songIds, revision);
      const output = { ok: true, action, ...data, affectedPlaylistIds: data.outcome === 'applied' ? [args.playlist_id] : [] };
      return result(output, data.outcome === 'noop' ? '歌单顺序无需调整' : '已调整个人歌单顺序');
    }
    if (action === 'update_metadata') {
      const revision = await resolveExpectedRevision(service, db, subject, args.playlist_id, args.expected_revision);
      const data = await service.updatePlaylist(db, subject, args.playlist_id, {
        expectedRevision: revision,
        ...(Object.hasOwn(args, 'name') ? { name: args.name } : {}),
        ...(Object.hasOwn(args, 'description') ? { description: args.description } : {}),
      });
      const output = { ok: true, action, ...data, affectedPlaylistIds: data.outcome === 'applied' ? [args.playlist_id] : [] };
      return result(output, data.outcome === 'noop' ? '歌单信息无需更新' : '已更新个人歌单信息');
    }
    if (action === 'delete') {
      const revision = await resolveExpectedRevision(service, db, subject, args.playlist_id, args.expected_revision);
      const data = await service.deletePlaylist(db, subject, args.playlist_id, revision);
      const output = { ok: true, action, ...data, affectedPlaylistIds: [args.playlist_id] };
      return result(output, '已删除个人歌单');
    }
    throw new AccountPlaylistError('INVALID_BODY', '未知的个人歌单动作。');
  } catch (error) {
    const output = { action, ...failed(error) };
    return result(output, output.message);
  }
}

export const managePlaylistTool = {
  name: 'manage_playlist',
  displayName: '管理账号歌单',
  description: '读取或管理当前登录听众的账号个人歌单。我的收藏名称与封面固定；详情编辑只调整曲序，明确指令仍可增删收藏歌曲。普通歌单支持创建、编辑与删除。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'create', 'add_songs', 'remove_songs', 'clear', 'replace_songs', 'reorder_songs', 'update_metadata', 'delete'],
        description: '操作类型：list（获取歌单列表）、read（读取歌单详情与歌曲）、create（创建新歌单）、add_songs（添加歌曲）、remove_songs（移除歌曲）、clear（清空歌单）、replace_songs（替换全部歌曲）、reorder_songs（调整歌曲顺序）、update_metadata（修改名称/简介）、delete（删除歌单）。',
      },
      playlist_id: {
        type: 'string',
        description: '目标歌单 ID（我的收藏为 fav_...，普通歌单为 pl_...，由 list/read 或 create 返回）。',
      },
      song_ids: {
        type: 'array',
        maxItems: 500,
        items: { type: 'string' },
        description: '歌曲 ID 数组（必须是 music_query 查询到的歌曲 id，如 ["4839ac1ad2a4e009"]；也支持传入精确歌名）。',
      },
      expected_revision: {
        type: 'integer',
        minimum: 0,
        description: '目标歌单的版本号 expectedRevision（可选；新建歌单为 0，已有歌单由 list/read 返回；若不提供则自动采用当前最新版本）。',
      },
      name: {
        type: 'string',
        maxLength: 40,
        description: '歌单名称（action=create 时必填，action=update_metadata 时可选）。',
      },
      description: {
        type: 'string',
        maxLength: 300,
        description: '歌单描述简介（可选）。',
      },
    },
    required: ['action'],
  },
  execute: executeManagePlaylist,
};
