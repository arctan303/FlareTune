export class AccountPlayStatsError extends Error {
  constructor(code, message, status = 400, data = undefined) {
    super(message);
    this.name = 'AccountPlayStatsError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export const MAX_PLAY_EVENT_BATCH_SIZE = 25;
export const PLAY_EVENT_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_PLAY_EVENT_RECEIPTS_PER_ACCOUNT = 10_000;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_SONG_ID_LENGTH = 256;

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new AccountPlayStatsError('MUSIC_STORAGE_UNAVAILABLE', '播放统计存储暂时不可用。', 503);
  }
}

function cleanSubject(userSub) {
  const subject = String(userSub || '').trim();
  if (!subject) {
    throw new AccountPlayStatsError('AUTH_REQUIRED', '需要登录账号才能记录或查询播放统计。', 401);
  }
  return subject;
}

function cleanEvents(eventsInput) {
  if (!Array.isArray(eventsInput)) {
    throw new AccountPlayStatsError('INVALID_BODY', 'events 必须是数组。', 400);
  }
  if (eventsInput.length === 0) return [];
  if (eventsInput.length > MAX_PLAY_EVENT_BATCH_SIZE) {
    throw new AccountPlayStatsError(
      'PAYLOAD_TOO_LARGE',
      `单次最多批量上报 ${MAX_PLAY_EVENT_BATCH_SIZE} 条播放事件。`,
      400,
    );
  }

  const events = eventsInput.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new AccountPlayStatsError('INVALID_BODY', '播放事件格式无效。', 400);
    }
    const eventId = typeof item.event_id === 'string' ? item.event_id.trim() : '';
    const songId = typeof item.song_id === 'string' ? item.song_id.trim() : '';
    const playedAt = Number(item.played_at);
    if (!eventId || eventId.length > MAX_EVENT_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(eventId)) {
      throw new AccountPlayStatsError('INVALID_BODY', '播放事件 event_id 格式无效。', 400);
    }
    if (!songId || songId.length > MAX_SONG_ID_LENGTH) {
      throw new AccountPlayStatsError('INVALID_BODY', '播放事件 song_id 格式无效。', 400);
    }
    if (!Number.isSafeInteger(playedAt) || playedAt <= 0) {
      throw new AccountPlayStatsError('INVALID_BODY', '播放事件 played_at 格式无效。', 400);
    }
    return { eventId, songId, playedAt };
  });

  const uniqueEvents = new Map();
  for (const event of events) {
    if (!uniqueEvents.has(event.eventId)) uniqueEvents.set(event.eventId, event);
  }
  return Array.from(uniqueEvents.values());
}

export async function recordSongPlays(db, userSub, eventsInput, now = Date.now()) {
  requireDb(db);
  const subject = cleanSubject(userSub);
  const events = cleanEvents(eventsInput);

  if (events.length === 0) {
    return { recorded: 0, acceptedEventIds: [] };
  }

  await db.prepare(`
    DELETE FROM Member_Play_Events
    WHERE user_sub = ? AND received_at < ?
  `).bind(subject, now - PLAY_EVENT_RECEIPT_RETENTION_MS).run();

  const currentReceiptCount = Number((await db.prepare(`
    SELECT COUNT(*) AS receipt_count
    FROM Member_Play_Events
    WHERE user_sub = ?
  `).bind(subject).first())?.receipt_count || 0);

  const valueSql = events.map(() => '(?, ?)').join(', ');
  const inventoryValues = events.flatMap((event) => [event.eventId, event.songId]);
  const inventory = await db.prepare(`
    WITH incoming(event_id, song_id) AS (VALUES ${valueSql})
    SELECT
      incoming.event_id,
      EXISTS(SELECT 1 FROM Songs WHERE id = incoming.song_id) AS song_exists,
      EXISTS(
        SELECT 1 FROM Member_Play_Events
        WHERE user_sub = ? AND event_id = incoming.event_id
      ) AS already_received
    FROM incoming
  `).bind(...inventoryValues, subject).all();
  const statusByEventId = new Map((inventory?.results || []).map((row) => [
    String(row.event_id),
    {
      songExists: Boolean(row.song_exists),
      alreadyReceived: Boolean(row.already_received),
    },
  ]));
  const newValidEvents = events.filter((event) => {
    const status = statusByEventId.get(event.eventId);
    return status?.songExists && !status.alreadyReceived;
  });

  if (currentReceiptCount + newValidEvents.length > MAX_PLAY_EVENT_RECEIPTS_PER_ACCOUNT) {
    throw new AccountPlayStatsError(
      'PLAY_EVENT_BUDGET_EXCEEDED',
      '近期播放事件过多，请稍后重试。',
      429,
    );
  }

  const statements = newValidEvents.map((event) => db.prepare(`
    INSERT INTO Member_Play_Events (user_sub, event_id, song_id, played_at, received_at)
    SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM Songs WHERE id = ?)
      AND (
        SELECT COUNT(*) FROM Member_Play_Events WHERE user_sub = ?
      ) < ?
    ON CONFLICT(user_sub, event_id) DO NOTHING
  `).bind(
    subject,
    event.eventId,
    event.songId,
    event.playedAt,
    now,
    event.songId,
    subject,
    MAX_PLAY_EVENT_RECEIPTS_PER_ACCOUNT,
  ));

  const results = statements.length > 0 ? await db.batch(statements) : [];
  const recorded = results.reduce(
    (sum, result) => sum + Number(result?.meta?.changes || 0),
    0,
  );
  if (recorded < newValidEvents.length) {
    throw new AccountPlayStatsError(
      'PLAY_EVENT_BUDGET_EXCEEDED',
      '近期播放事件过多，请稍后重试。',
      429,
    );
  }

  return {
    recorded,
    acceptedEventIds: events.map((event) => event.eventId),
  };
}

export async function getTopPlayedSongs(db, userSub, limitInput = 20) {
  requireDb(db);
  const subject = cleanSubject(userSub);

  const rawLimit = Number(limitInput);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 50)
    : 20;

  const [songsResult, summaryResult] = await Promise.all([
    db.prepare(`
      SELECT
        s.id,
        s.title,
        s.artist,
        s.album,
        s.duration,
        s.audio_url,
        s.cover_url,
        s.language,
        p.play_count,
        p.last_played_at
      FROM Member_Song_Plays p
      JOIN Songs s ON p.song_id = s.id
      WHERE p.user_sub = ?
      ORDER BY p.play_count DESC, p.last_played_at DESC
      LIMIT ?
    `).bind(subject, limit).all(),
    db.prepare(`
      SELECT
        COALESCE(SUM(play_count), 0) AS total_plays,
        COUNT(*) AS total_unique_songs
      FROM Member_Song_Plays
      WHERE user_sub = ?
    `).bind(subject).first(),
  ]);

  return {
    songs: songsResult?.results || [],
    totalPlays: Number(summaryResult?.total_plays || 0),
    totalUniqueSongs: Number(summaryResult?.total_unique_songs || 0),
  };
}
