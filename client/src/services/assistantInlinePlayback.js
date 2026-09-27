import { fetchSongById } from './songApi.js';
import { getApiBaseUrl } from './apiBase.js';
import { hydratePlayableSong } from '../utils.js';
import { repairSongLanguages, songHasValidLanguage } from '../resolveSongs.js';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { applyPlaySongNow } from '../assistantPlayerActions.js';
import { showToast } from '../store/useUIStore.js';

// Only a user click/keyboard activation in XiaoaMarkdown invokes this helper.
// Assistant tool responses never execute player actions by themselves.
export async function playAssistantInlineSong(songId, {
  fetchSong = fetchSongById,
  repairSongs = repairSongLanguages,
  hydrateSong = hydratePlayableSong,
  validLanguage = songHasValidLanguage,
  getState = usePlayerStore.getState,
  playSong = applyPlaySongNow,
  apiBase = getApiBaseUrl,
  notify = showToast,
} = {}) {
  const id = typeof songId === 'string' ? songId.trim() : '';
  if (!id || id.length > 256) return { ok: false, reason: 'invalid_song_id' };
  const current = getState();
  if (String(current.currentSong?.id || '') === id) {
    if (!current.isPlaying) current.togglePlay();
    return { ok: true, outcome: current.isPlaying ? 'already_playing' : 'resumed' };
  }
  try {
    const raw = await fetchSong(id);
    if (!raw) {
      notify('歌曲不存在或无法播放');
      return { ok: false, reason: 'song_not_found' };
    }
    const repaired = await repairSongs([raw], { apiBase: apiBase() });
    const song = hydrateSong(repaired?.songs?.[0]);
    if (!song || !validLanguage(song)) {
      notify('无法取得该曲目的播放信息');
      return { ok: false, reason: 'song_unplayable' };
    }
    const result = await playSong(song, { getState });
    if (!result?.ok) {
      notify('播放未成功，请再试一次');
      return { ok: false, reason: 'playback_failed' };
    }
    notify(`正在播放《${song.title || '歌曲'}》`);
    return { ok: true, outcome: 'started' };
  } catch {
    notify('无法取得该曲目的播放信息');
    return { ok: false, reason: 'song_unavailable' };
  }
}

export function activateInlineAssistantSong(event, {
  keyboard = false,
  playSong = playAssistantInlineSong,
} = {}) {
  if (keyboard && event?.key !== 'Enter' && event?.key !== ' ') return false;
  const target = event?.target?.closest?.('.xiaoa-inline-song');
  const songId = target?.getAttribute?.('data-song-id');
  if (!songId) return false;
  event.preventDefault();
  event.stopPropagation();
  void playSong(songId);
  return true;
}
