import { getCurrentPlaybackTool } from './getCurrentPlayback.js';
import { musicQueryTool } from './musicQuery.js';
import { musicControlTool } from './musicControl.js';
import { managePlaylistTool } from './managePlaylist.js';
import { playerQueueTool } from './playerQueue.js';
import { playerSeekTool } from './playerSeek.js';
import { currentTimeTool } from './currentTime.js';
import { myListeningStatsTool } from './myListeningStats.js';
import { roamControlTool } from './roamControl.js';
import { assertToolResult, createToolFailure } from './toolResult.js';

// 模型可见工具：共享查询、乐境账号歌单服务端工具与播放器浏览器工具。
export const tools = [
  musicQueryTool,
  musicControlTool,
  getCurrentPlaybackTool,
  currentTimeTool,
  managePlaylistTool,
  playerQueueTool,
  playerSeekTool,
  myListeningStatsTool,
  roamControlTool,
];

// 暴露给大模型 API 的工具结构定义数组
export const AI_TOOLS = tools.map(t => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }
}));

export function getToolDisplayName(name) {
  return tools.find(tool => tool.name === name)?.displayName || name;
}

const cleanProgressTarget = (value, maxLength = 36) => {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .normalize('NFKC')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[^\p{L}\p{N}\p{M}\s·・&＋+—_-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, maxLength).join('').trim();
};

const wrapProgressTarget = (value, fallback) => {
  const target = cleanProgressTarget(value);
  return target ? `《${target}》` : fallback;
};

const chooseProgressVariant = (variants, seed = '') => {
  if (!Array.isArray(variants) || variants.length === 0) return '';
  if (!seed) return variants[0];
  let hash = 2166136261;
  for (const char of String(seed)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return variants[(hash >>> 0) % variants.length];
};

export function getToolProgressText(name, args = {}, callId = '') {
  const payload = args && typeof args === 'object' ? args : {};
  if (name === 'music_query') {
    const action = String(payload.action || (payload.keyword ? 'search' : 'random'));
    if (action === 'search') {
      const target = wrapProgressTarget(payload.keyword, '这首歌');
      return chooseProgressVariant([
        `我去曲库里找一下${target}。`,
        `我帮你看看曲库里的${target}。`,
        `我先核对一下${target}的曲库信息。`,
        `我在曲库里找找${target}。`,
      ], callId);
    }
    return chooseProgressVariant(['我从曲库里挑几首。', '我去曲库里转一圈。', '我从乐境里找几首合适的。', '我看看曲库里有什么值得一听的。'], callId);
  }
  if (name === 'music_control') {
    if (payload.action === 'play_song') {
      const target = wrapProgressTarget(payload.song_name, '这首歌');
      return chooseProgressVariant([`我准备一下${target}。`, `我去把${target}找出来。`, `我先确认一下${target}的播放信息。`, `我帮你把${target}接到播放器上。`], callId);
    }
    return chooseProgressVariant(['我处理一下播放器状态。', '我来调整一下播放状态。', '我看看播放器现在的状态。', '我帮你操作一下播放器。'], callId);
  }
  if (name === 'current_time') return chooseProgressVariant(['我确认一下当前时间。', '我看一眼现在的时间。', '我去核对一下时区和时间。', '我帮你查一下当地时间。'], callId);
  if (name === 'manage_playlist') {
    if (payload.action === 'list' || payload.action === 'read') return chooseProgressVariant(['我看看你的歌单。', '我去翻一下你的歌单。', '我先读一下歌单状态。', '我帮你确认一下歌单内容。'], callId);
    if (payload.action === 'create') {
      const target = wrapProgressTarget(payload.name, '');
      return chooseProgressVariant([`我准备一下新歌单${target}。`, `我先核对一下新歌单${target}。`, `我来整理一下新歌单${target}。`, `我帮你把新歌单${target}建起来。`], callId);
    }
    return chooseProgressVariant(['我先核对一下这个歌单。', '我看看歌单现在的状态。', '我先确认一下这次歌单调整。', '我来处理一下这份歌单。'], callId);
  }
  if (name === 'player_queue') return chooseProgressVariant(['我准备调整一下播放队列。', '我先看看现在的播放队列。', '我来整理一下接下来要播放的内容。', '我帮你安排一下接下来的播放顺序。'], callId);
  if (name === 'player_seek') return chooseProgressVariant(['我准备调整一下播放进度。', '我先确认一下要跳到的位置。', '我来处理一下播放位置。', '我帮你把进度移到合适的位置。'], callId);
  if (name === 'my_listening_stats') return chooseProgressVariant(['我看看你的收听统计。', '我去翻一下你的收听记录。', '我先核对一下你的播放数据。', '我帮你理一下你常听的歌。'], callId);
  if (name === 'my_playlists') return chooseProgressVariant(['我看看你的个人歌单。', '我先读一下你的歌单内容。'], callId);
  if (name === 'song_details') return chooseProgressVariant(['我读一下这首歌的资料。', '我核对一下这首歌的信息。'], callId);
  if (name === 'roam_control') {
    if (payload.action === 'disable') return chooseProgressVariant(['我准备关闭随机漫游。', '我先处理一下随机漫游的开关。', '我来关掉随机漫游。', '我帮你把随机漫游停下。'], callId);
    return chooseProgressVariant(['我准备开启随机漫游。', '我先处理一下随机漫游的开关。', '我来打开随机漫游。', '我帮你把随机漫游开起来。'], callId);
  }
  return chooseProgressVariant(['我先核对一下相关信息。', '我去确认一下。', '我先看看具体情况。', '我帮你查一下。'], callId);
}

// 工具生产者已统一返回 createToolResult DTO，这里只负责路由与异常边界。
export async function executeTool(name, args, context) {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    return createToolFailure({
      modelText: '工具不可用。',
      summary: `未知工具 ${name}`,
      type: 'knowledge',
      code: 'unknown_tool',
      message: `未知工具: ${name}`,
    });
  }

  if (!context?.user?.subject) {
    return createToolFailure({
      modelText: '登录状态已失效，请重新登录后再试。',
      summary: '需要登录账号',
      type: 'authentication',
      code: 'authentication_required',
      message: 'authenticated user context is required',
    });
  }

  try {
    return assertToolResult(await tool.execute(args, context));
  } catch (err) {
    console.error(`Tool execution failed [${name}]:`, err);
    return createToolFailure({
      modelText: '工具查询失败，请稍后再试。',
      summary: `工具 ${name} 执行异常`,
      type: name === 'music_query' ? 'music_cards' : 'knowledge',
      code: 'database_query_failed',
      message: err.message || String(err),
    });
  }
}
