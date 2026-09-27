const PLAYER_ACTION_RECEIPT_LIMIT = 10;
const RECEIPT_ID_MAX = 120;
const RECEIPT_OUTCOME_MAX = 300;

/**
 * 延迟式指令回执：只保留 `{ id, ok, outcome }`，与服务端 sanitizePlayerActionReceipts 同一契约。
 */
const normalizePlayerActionReceipts = (value) => {
  if (!Array.isArray(value)) return undefined;
  const receipts = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, RECEIPT_ID_MAX) : '';
    if (!id || typeof item.ok !== 'boolean') return [];
    const outcome = typeof item.outcome === 'string' ? item.outcome.trim().slice(0, RECEIPT_OUTCOME_MAX) : '';
    return [{ id, ok: item.ok, outcome }];
  }).slice(0, PLAYER_ACTION_RECEIPT_LIMIT);
  return receipts.length > 0 ? receipts : undefined;
};

export function normalizeAssistantContext(value) {
  const context = value && typeof value === 'object' ? value : {};
  const playback = context.playback && typeof context.playback === 'object' ? context.playback : null;
  const finite = (input) => Number.isFinite(Number(input)) ? Number(input) : null;
  const integer = (input) => Number.isInteger(Number(input)) ? Number(input) : null;
  return {
    location: typeof context.location === 'string' ? context.location.trim().slice(0, 500) : '',
    pageContext: typeof context.pageContext === 'string' ? context.pageContext.trim().slice(0, 1500) : '',
    playerActionReceipts: normalizePlayerActionReceipts(context.playerActionReceipts),
    playback: playback ? {
      songId: String(playback.songId || '').slice(0, 120),
      title: String(playback.title || '').slice(0, 200),
      artist: String(playback.artist || '').slice(0, 200),
      album: String(playback.album || '').slice(0, 200),
      isPlaying: playback.isPlaying === true,
      isBuffering: playback.isBuffering === true,
      currentTime: finite(playback.currentTime),
      duration: finite(playback.duration),
      playMode: typeof playback.playMode === 'string' ? playback.playMode.slice(0, 30) : undefined,
      queueLength: integer(playback.queueLength),
      currentIndex: integer(playback.currentIndex),
      upcomingSongs: Array.isArray(playback.upcomingSongs)
        ? playback.upcomingSongs.slice(0, 15).map((s) => ({
            id: String(s?.id || '').slice(0, 120),
            title: String(s?.title || '').slice(0, 200),
            artist: String(s?.artist || '').slice(0, 200),
          }))
        : undefined,
    } : null,
  };
}

export function normalizeAssistantToolProgress(value) {
  if (typeof value !== 'string') return '';
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(normalized).slice(0, 100).join('').trim();
}

export const normalizeXiaoaContext = normalizeAssistantContext;
export const normalizeXiaoaToolProgress = normalizeAssistantToolProgress;
