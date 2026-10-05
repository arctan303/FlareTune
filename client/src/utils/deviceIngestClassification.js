import { compareSongIdentity, normalizeSongIdentityText } from './songDuplicateCheck.js';

export const DEVICE_INGEST_STATES = {
  new: '新增', duplicate: '疑似重复', saved: '已入库', changed: '文件有变化',
  unfinished: '未完成', all: '全部',
};

export function deviceSongDraft(file) {
  return { title: file.common?.title?.trim() || file.name.replace(/\.[^.]+$/, ''),
    artist: file.common?.artist?.trim() || file.common?.artists?.join('、') || '',
    album: file.common?.album?.trim() || '', duration: file.duration || '' };
}

function indexByTitle(items, draftOf) {
  const index = new Map();
  for (const item of items) {
    const title = normalizeSongIdentityText(draftOf(item).title);
    if (!index.has(title)) index.set(title, []);
    index.get(title).push(item);
  }
  return index;
}

// A complete read is required: partial catalog pages cannot prove a file is new.
export async function loadIngestCatalog(listSongs) {
  const songs = [];
  const seen = new Set();
  let total;
  for (let page = 1; ; page += 1) {
    const result = await listSongs({ page, limit: 100 });
    if (!Array.isArray(result?.songs) || !Number.isSafeInteger(result.total) || result.total < 0
      || total !== undefined && result.total !== total) throw new Error('曲库已变化，请重新检查。');
    total = result.total;
    for (const song of result.songs) {
      if (!song.id || seen.has(song.id)) throw new Error('曲库已变化，请重新检查。');
      seen.add(song.id);
      songs.push(song);
    }
    if (songs.length === total) return songs;
    if (!result.songs.length || songs.length > total) throw new Error('曲库读取不完整，请重新检查。');
  }
}

export function classifyDeviceFiles(files, catalog, queueEntries = [], deviceId = '') {
  const byTitle = indexByTitle(catalog, (song) => song);
  const byAudio = new Map(catalog.filter((song) => song.audio_url).map((song) => [song.audio_url, song]));
  const prior = new Map();
  const queued = new Map(queueEntries.filter((entry) => entry.agent?.deviceId === deviceId)
    .map((entry) => [entry.agent.fileId, entry]));
  return files.map((file) => {
    const draft = deviceSongDraft(file);
    const title = normalizeSongIdentityText(draft.title);
    const catalogMatches = (byTitle.get(title) || []).flatMap((song) => {
      const strength = compareSongIdentity(draft, song);
      return strength ? [{ source: 'catalog', strength, ...song }] : [];
    });
    const localMatches = (prior.get(title) || []).flatMap((other) => {
      const strength = compareSongIdentity(draft, other.draft);
      return strength ? [{ source: 'device', strength, id: other.file.id, ...other.draft,
        path: other.file.path }] : [];
    });
    const entry = queued.get(file.id);
    const audioUrl = entry?.uploaded?.audio?.url || file.ingest?.audio?.url;
    const savedSong = byAudio.get(audioUrl);
    const matches = [...catalogMatches, ...localMatches];
    const status = savedSong ? 'saved' : file.ingest?.changed ? 'changed'
      : matches.length ? 'duplicate' : file.ingest?.audio || file.ingest?.cover
        ? 'unfinished' : 'new';
    // Keep one representative from a local-only group. Already imported files
    // also have catalog matches, so all of their copies remain excluded.
    if (!prior.has(title)) prior.set(title, []);
    prior.get(title).push({ file, draft });
    return { ...file, ingestStatus: status, matches, savedSong,
      inQueue: Boolean(entry), queueStatus: entry?.status };
  });
}

export function excludeUnreviewedDuplicates(entries) {
  return entries.filter((entry) => entry.status === 'saved' || entry.allowDuplicate
    || !entry.reviewStale && !entry.duplicateMatches?.length);
}
