import { planInsertNext, planQueueEdit } from './store/playerQueue.js';
import { hydrateSong } from './utils.js';
import { isValidSongLanguage } from './constants/language.js';

const isAbsoluteUrl = (url) => typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));

const ensureHydratedSong = (song) => {
  if (!song) return song;
  if (song.audio_url && !isAbsoluteUrl(song.audio_url)) {
    return hydrateSong(song);
  }
  return song;
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const observeAudioStart = (audio, start, observationMs = 400) => new Promise((resolve) => {
  let settled = false;
  let timeoutId;
  const finish = (playbackState, error) => {
    if (settled) return;
    settled = true;
    if (timeoutId) clearTimeout(timeoutId);
    audio.removeEventListener?.('playing', onPlaying);
    audio.removeEventListener?.('error', onError);
    resolve({ playbackState, error });
  };
  const onPlaying = () => finish('playing');
  const onError = () => finish('failed', audio.error);

  audio.addEventListener?.('playing', onPlaying, { once: true });
  audio.addEventListener?.('error', onError, { once: true });
  timeoutId = setTimeout(
    () => finish(audio.error ? 'failed' : 'buffering', audio.error),
    observationMs,
  );
  try {
    const pending = start();
    if (pending && typeof pending.then === 'function') {
      Promise.resolve(pending)
        .then(() => finish('playing'))
        .catch((error) => finish('failed', error));
    }
  } catch (error) {
    finish('failed', error);
  }
});

const normalizeMediaUrl = (value) => {
  if (!value) return '';
  try {
    return new URL(value, globalThis.location?.href || 'https://xiaoa.invalid/').href;
  } catch {
    return String(value);
  }
};

const audioHasSongSource = (audio, song) => {
  const targetSource = normalizeMediaUrl(song?.audio_url);
  if (!targetSource) return false;
  const declaredSources = [
    audio?.src,
    audio?.getAttribute?.('src'),
  ].filter(Boolean);
  if (declaredSources.length > 0) {
    return declaredSources.some((source) => normalizeMediaUrl(source) === targetSource);
  }
  return normalizeMediaUrl(audio?.currentSrc) === targetSource;
};

const waitForAudioElement = async (getState, song, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = getState();
    const audio = state.audioRef?.current;
    if (state.currentSong?.id === song.id && audioHasSongSource(audio, song)) return audio;
    await delay(25);
  } while (Date.now() < deadline);
  return null;
};

const playbackTargetIsCurrent = (state, audio, song) => (
  String(state.currentSong?.id ?? '') === String(song?.id ?? '')
  && state.audioRef?.current === audio
  && audioHasSongSource(audio, song)
);

const playbackQueueLength = (state, fallbackPlaylist) => (
  Array.isArray(state?.playlist) ? state.playlist.length : fallbackPlaylist.length
);

const startPlayback = async (
  song,
  playlist,
  { getState, timeoutMs = 3000, playbackObservationMs = 400 },
) => {
  const before = getState();
  if (!before.playSong(song, playlist)) return { ok: false, outcome: 'failed', playback_state: 'failed', error: 'player_action_rejected' };
  getState().setShouldAutoPlay(false);

  const audio = await waitForAudioElement(getState, song, timeoutMs);
  if (!audio) {
    const state = getState();
    if (String(state.currentSong?.id ?? '') !== String(song.id)) {
      return {
        ok: false,
        outcome: 'partial',
        playback_state: 'failed',
        error: 'playback_superseded',
        queueLength: playbackQueueLength(state, playlist),
      };
    }
    state.setIsPlaying(false);
    return {
      ok: false,
      outcome: 'partial',
      playback_state: 'failed',
      error: 'audio_unavailable',
      queueLength: playbackQueueLength(state, playlist),
    };
  }
  audio.currentTime = 0;
  const playback = await observeAudioStart(audio, () => audio.play(), playbackObservationMs);
  const state = getState();
  if (!playbackTargetIsCurrent(state, audio, song)) {
    return {
      ok: false,
      outcome: 'partial',
      playback_state: 'failed',
      error: 'playback_superseded',
      queueLength: playbackQueueLength(state, playlist),
    };
  }
  if (playback.playbackState === 'failed') {
    state.setIsPlaying(false);
    return {
      ok: false,
      outcome: 'partial',
      playback_state: 'failed',
      error: 'playback_rejected',
      message: playback.error?.message,
      queueLength: playbackQueueLength(state, playlist),
    };
  }
  state.setProgress(0);
  state.setIsPlaying(true);
  return {
    ok: true,
    outcome: 'applied',
    playback_state: playback.playbackState,
    queueLength: playbackQueueLength(state, playlist),
  };
};

export function applyPlayerQueueEdit({ operation, songs: rawSongs }, { getState }) {
  const songs = Array.isArray(rawSongs) ? rawSongs.map(ensureHydratedSong).filter(Boolean) : [];
  const state = getState();
  const plan = planQueueEdit(state.playlist, state.currentSong, songs, operation);
  if (plan.action === 'reject') return { ok: false, error: 'invalid_queue_edit' };
  if (plan.action === 'noop') {
    return { ok: true, outcome: 'noop', affectedSongIds: [], queueLength: plan.playlist.length };
  }
  state.setPlaylist(plan.playlist);
  return {
    ok: true,
    outcome: 'applied',
    affectedSongIds: plan.affectedSongIds,
    queueLength: plan.playlist.length,
  };
}

export function applyCurrentSongMetadataAndToggle(rawSong, { getState } = {}) {
  const song = ensureHydratedSong(rawSong);
  const state = typeof getState === 'function' ? getState() : null;
  if (!song?.id || !isValidSongLanguage(song.language)) return false;
  if (String(state?.currentSong?.id ?? '') !== String(song.id)) return false;
  if (typeof state.patchSongMetadata !== 'function' || typeof state.togglePlay !== 'function') return false;
  state.patchSongMetadata(song.id, { language: song.language });
  state.togglePlay();
  return true;
}

export async function applyPlaySongNow(
  rawSong,
  { getState, timeoutMs = 3000, playbackObservationMs = 400 } = {},
) {
  const song = ensureHydratedSong(rawSong);
  const before = getState();
  // 立即播放 = 与“下一首播放”相同的插播规划（保留队列，插入当前曲目之后），随后立即起播。
  const plan = planInsertNext(before.playlist, before.currentSong, song);
  if (plan.action === 'reject') return { ok: false, playback_state: 'failed', error: 'unplayable_song' };
  if (plan.action === 'noop') {
    return startPlayback(before.currentSong, before.playlist, { getState, timeoutMs, playbackObservationMs });
  }
  return startPlayback(song, plan.playlist, { getState, timeoutMs, playbackObservationMs });
}

export async function applyReplacePlayerQueue(
  rawSongs,
  { getState, timeoutMs = 3000, playbackObservationMs = 400 } = {},
) {
  const songs = Array.isArray(rawSongs) ? rawSongs.map(ensureHydratedSong).filter(Boolean) : [];
  if (songs.length === 0) {
    return { ok: false, outcome: 'failed', playback_state: 'failed', error: 'unplayable_queue' };
  }
  return startPlayback(songs[0], songs, { getState, timeoutMs, playbackObservationMs });
}

export async function applyPlayerControl(args, { getState, playbackObservationMs = 400 }) {
  const type = args?.type;
  const action = args?.action;
  const isControlAction = type === 'control' && ['play', 'pause', 'toggle'].includes(action);
  const isSeekAction = type === 'seek'
    && action === 'seek'
    && ['seconds', 'percent'].includes(args?.mode);
  if (!isControlAction && !isSeekAction) {
    return { ok: false, action, error: 'unknown_action' };
  }
  const state = getState();
  const audio = state.audioRef?.current;
  if (!state.currentSong || !audio) {
    if ((action === 'play' || action === 'toggle') && Array.isArray(state.playlist) && state.playlist.length > 0) {
      return applyPlaySongNow(state.playlist[0], { getState, playbackObservationMs });
    }
    return { ok: false, action, playback_state: 'failed', error: 'no_current_playback' };
  }

  if (action === 'play') {
    if (!audio.paused) return {
      ok: true,
      outcome: 'noop',
      action,
      is_playing: true,
      playback_state: 'playing',
    };
    const playback = await observeAudioStart(audio, () => audio.play(), playbackObservationMs);
    if (playback.playbackState !== 'failed') {
      getState().setIsPlaying(true);
      return {
        ok: true,
        outcome: 'applied',
        action,
        is_playing: true,
        playback_state: playback.playbackState,
      };
    }
    getState().setIsPlaying(false);
    return { ok: false, action, playback_state: 'failed', error: 'playback_rejected', message: playback.error?.message };
  }

  if (action === 'pause') {
    if (audio.paused) {
      getState().setIsPlaying(false);
      return { ok: true, outcome: 'noop', action, is_playing: false };
    }
    audio.pause();
    getState().setIsPlaying(false);
    return { ok: true, outcome: 'applied', action, is_playing: false };
  }

  if (action === 'toggle') {
    return applyPlayerControl(
      { type: 'control', action: audio.paused ? 'play' : 'pause' },
      { getState, playbackObservationMs },
    );
  }

  if (isSeekAction) {
    const isPercent = args.mode === 'percent';
    const songDuration = Number(state.currentSong?.duration);
    const duration = (Number.isFinite(audio.duration) && audio.duration > 0)
      ? audio.duration
      : ((Number.isFinite(state.duration) && state.duration > 0)
        ? state.duration
        : ((Number.isFinite(songDuration) && songDuration > 0) ? songDuration : 0));
    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, action, error: 'duration_unavailable' };
    }
    const rawPosition = args.position;
    const requested = isPercent
      ? (Number(rawPosition) / 100) * duration
      : Number(rawPosition);
    if (!Number.isFinite(requested)) return { ok: false, action, error: 'position_required' };
    const position = Math.min(Math.max(requested, 0), duration);
    const outcome = Math.abs((Number(audio.currentTime) || 0) - position) <= 0.05 ? 'noop' : 'applied';
    audio.currentTime = position;
    getState().setProgress(position);
    return {
      ok: true,
      outcome,
      action,
      position_seconds: Number(audio.currentTime),
      duration_seconds: duration,
    };
  }

  return { ok: false, action, error: 'unknown_action' };
}

/**
 * 小A 漫游指令：复用 RoamSettingsDrawer / MainContent 同一份 randomRoam 状态机。
 * 语种沿用现有语种维度（all / zh / ja / en / yue），不做范围扩展。
 */
export function applyRoamControl({ action, language } = {}, { getState } = {}) {
  const state = typeof getState === 'function' ? getState() : null;
  if (typeof state?.setRandomRoamEnabled !== 'function') {
    return { ok: false, outcome: 'failed', error: 'roam_unavailable' };
  }

  const wasEnabled = state.randomRoam?.enabled === true;
  if (action === 'disable') {
    state.setRandomRoamEnabled(false);
    return { ok: true, outcome: wasEnabled ? 'applied' : 'noop', enabled: false };
  }
  if (action !== 'enable') return { ok: false, outcome: 'ignored' };

  const requested = typeof language === 'string' ? language.trim() : '';
  const nextLanguage = requested || state.randomRoam?.language || 'all';
  const isSameScope = wasEnabled && (state.randomRoam?.language || 'all') === nextLanguage;
  state.setRandomRoamEnabled(true, { language: nextLanguage });
  return {
    ok: true,
    outcome: isSameScope ? 'noop' : 'applied',
    enabled: true,
    language: nextLanguage,
  };
}

/**
 * 播放今日推荐全部已退役：原 `daily_recommend` 工具（Phase 78 引入）已由 Phase 79 移除，
 * 今日精选的刷新与播放全部仍由详情页自身入口提供。
 */
