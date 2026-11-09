// Source identity must survive queues, deep links and metadata-only references.
// YouTube ids identify a particular upload/version, rather than an acoustic work.
export const isYouTubeEntity = (value) => value?.source === 'youtube'
  || /^yt:/.test(String(value?.id ?? value ?? ''));

// Editing/importing a catalog record is distinct from retaining an account reference.
export const canUseLocalSongLibrary = (song) => !isYouTubeEntity(song);
const YOUTUBE_SONG_ID = /^yt:([A-Za-z0-9_-]{11})$/;
export function canReferenceAccountSong(songOrId) {
  const value = songOrId && typeof songOrId === 'object' ? songOrId.id : songOrId;
  const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!id || id.length > 256) return false;
  return !(isYouTubeEntity(songOrId) || id.startsWith('yt:')) || YOUTUBE_SONG_ID.test(id);
}

// Keep a small public reference in browser history/statistics; never retain signed streams.
export function songSourceMetadata(song) {
  const match = String(song?.id || '').match(YOUTUBE_SONG_ID);
  if (!match) return {};
  return {
    source: 'youtube', sourceId: match[1],
    artists: (Array.isArray(song.artists) ? song.artists : []).flatMap(artist =>
      typeof artist?.id === 'string' && typeof artist?.name === 'string'
        ? [{ id: artist.id, name: artist.name }] : []),
    ...(typeof song.albumId === 'string' ? { albumId: song.albumId } : {}),
  };
}

export function artistIdentity(artist) {
  return isYouTubeEntity(artist) && String(artist?.id || '').startsWith('yt:artist:')
    ? artist.id : artist?.name || '';
}

export function artistFromSong(song, name = song?.artist || '') {
  const match = song?.artists?.find(artist => artist.name === name) || song?.artists?.[0];
  const rawId = match?.id || song?.artistId;
  const id = rawId && isYouTubeEntity(song)
    ? (String(rawId).startsWith('yt:artist:') ? rawId : `yt:artist:${rawId}`) : undefined;
  return { name: match?.name || name, coverUrl: song?.cover_url,
    ...(id ? { id, source: 'youtube' } : {}) };
}

export function youtubeSearchWarning(warnings = []) {
  if (warnings.some(item => item?.source === 'youtube' && item.code === 'language_filter')) {
    return 'YouTube 暂不提供可靠的歌曲语种筛选，请选择全部语种查看结果。';
  }
  if (warnings.some(item => item?.source === 'youtube' && item.code === 'rate_limited')) {
    return 'YouTube Music 请求过于频繁，请稍后重试。';
  }
  return warnings.some(item => item?.source === 'youtube' && item.code === 'unavailable')
    ? 'YouTube Music 暂时不可用，已保留本地搜索结果。' : '';
}
