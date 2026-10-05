import { LyricSourceError } from './lyricSourceError.js';
import {
  createProviderMeta,
  normalizeDurationSeconds,
  rankLyricCandidates,
  splitArtistKeys,
  splitArtistLabels,
  stripKugouTitleSuffixes,
} from './lyricSourceMatching.js';
import {
  createLyricDocument,
  parseLrcDocument,
} from '../utils/lyricDocument.js';
import { isNonLyricText } from '../utils/lyricsParsing.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_JSON_BYTES = 4_000_000;
const LRC_TIMESTAMP_REGEX = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LRC_METADATA_REGEX = /^\[[A-Za-z][\w-]*:/;

const NETEASE_HEADERS = Object.freeze({
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com',
  Cookie: 'os=pc; appver=2.9.7;',
});

const NETEASE_RANKING_OPTIONS = Object.freeze({
  titleKeys: ['name', 'song', 'songname', 'trackName'],
  artistKeys: ['artistName', 'singer', 'singername'],
  albumKeys: ['albumName', 'album', 'album_name'],
  durationKeys: ['duration'],
});

const responseStatusKind = (response) => {
  if (response?.status === 404) return 'unavailable';
  if (response?.status === 408 || response?.status === 504) return 'timeout';
  if (response?.status === 429) return 'rate_limited';
  if (response?.status >= 500) return 'upstream';
  return 'invalid';
};

const byteLength = (value) => new TextEncoder().encode(value).byteLength;

async function fetchNeteaseJson(fetchImpl, url, {
  stage,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal: requestSignal,
} = {}) {
  const controller = new AbortController();
  let didTimeout = false;
  const abortFromRequest = () => controller.abort(requestSignal.reason || new DOMException('Aborted', 'AbortError'));
  if (requestSignal?.aborted) abortFromRequest();
  else requestSignal?.addEventListener('abort', abortFromRequest, { once: true });
  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error('upstream timeout'));
  }, timeoutMs);

  try {
    if (requestSignal?.aborted) {
      throw new LyricSourceError('aborted', 'netease', stage, `netease ${stage} aborted`);
    }
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: NETEASE_HEADERS,
    });
    if (!response?.ok) {
      throw new LyricSourceError(
        responseStatusKind(response),
        'netease',
        stage,
        `netease ${stage} HTTP ${response?.status || 0}`,
      );
    }
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (byteLength(text) > MAX_JSON_BYTES) throw new RangeError('upstream response exceeds safe size');
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new LyricSourceError('invalid', 'netease', stage, `netease ${stage} returned invalid JSON`, { cause: error });
      }
    }
    const value = await response.json();
    if (byteLength(JSON.stringify(value)) > MAX_JSON_BYTES) throw new RangeError('upstream JSON exceeds safe size');
    return value;
  } catch (error) {
    if (error instanceof LyricSourceError) throw error;
    if (error instanceof SyntaxError || error instanceof RangeError) {
      throw new LyricSourceError('invalid', 'netease', stage, `netease ${stage} returned invalid JSON`, { cause: error });
    }
    const kind = requestSignal?.aborted
      ? 'aborted'
      : (didTimeout || error?.name === 'AbortError' ? 'timeout' : 'network');
    throw new LyricSourceError(kind, 'netease', stage, `netease ${stage} ${kind}`, { cause: error });
  } finally {
    clearTimeout(timeoutId);
    requestSignal?.removeEventListener('abort', abortFromRequest);
  }
}

const lrcFractionToSeconds = (fraction = '') => {
  if (!fraction) return 0;
  if (fraction.length === 1) return Number(fraction) / 10;
  if (fraction.length === 2) return Number(fraction) / 100;
  return Number(fraction.slice(0, 3).padEnd(3, '0')) / 1_000;
};

export function parseLrcTimestampEntries(lrcText) {
  if (typeof lrcText !== 'string' || !lrcText.trim()) return [];
  const entries = [];
  for (const rawLine of lrcText.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || LRC_METADATA_REGEX.test(trimmed)) continue;
    const matches = [...trimmed.matchAll(LRC_TIMESTAMP_REGEX)];
    const text = trimmed.replace(LRC_TIMESTAMP_REGEX, '').trim();
    if (!text || isNonLyricText(text)) continue;
    for (const match of matches) {
      const time = (Number(match[1]) * 60) + Number(match[2]) + lrcFractionToSeconds(match[3]);
      entries.push({ time, text });
    }
  }
  return entries;
}

export function alignTranslationToLines(lines, tlyricText) {
  const tEntries = parseLrcTimestampEntries(tlyricText);
  if (tEntries.length === 0) return lines;

  return lines.map((line) => {
    if (line.time === undefined || line.time === null || !Number.isFinite(line.time)) {
      return line;
    }
    let bestMatch = null;
    let minDelta = Number.POSITIVE_INFINITY;
    for (const entry of tEntries) {
      const delta = Math.abs(entry.time - line.time);
      if (delta <= 0.05 && delta < minDelta) {
        minDelta = delta;
        bestMatch = entry;
      }
    }
    if (bestMatch && bestMatch.text) {
      return { ...line, tlyric: bestMatch.text };
    }
    return line;
  });
}

export function buildNeteaseSearchKeywords(song) {
  const title = String(song?.title || song?.name || '').trim();
  if (!title) return [];
  const artist = String(song?.artist || '').trim();
  const artistLabels = splitArtistLabels(artist);
  const primaryArtist = artistLabels[0] || '';
  const cleanTitle = stripKugouTitleSuffixes(title) || title;

  const variants = [
    artist ? `${title} ${artist}` : title,
    primaryArtist && primaryArtist !== artist ? `${title} ${primaryArtist}` : '',
    cleanTitle !== title && artist ? `${cleanTitle} ${artist}` : '',
    cleanTitle !== title && primaryArtist ? `${cleanTitle} ${primaryArtist}` : '',
    title,
  ].filter(Boolean);

  return [...new Set(variants.map((v) => v.trim()).filter(Boolean))].slice(0, 4);
}

export function parseNeteaseLyricDocument(data, { providerMeta } = {}) {
  const lrcText = data?.lrc?.lyric;
  if (!lrcText || typeof lrcText !== 'string' || !lrcText.trim()
    || data?.nolyric === true || data?.uncollected === true) {
    throw new LyricSourceError('unavailable', 'netease', 'lyrics', 'Netease song has no lyrics');
  }

  const baseDocument = parseLrcDocument(lrcText, { source: 'netease', format: 'lrc', providerMeta });
  if (!baseDocument.lines || baseDocument.lines.length === 0) {
    throw new LyricSourceError('unavailable', 'netease', 'lyrics', 'Netease lyric contains no valid lines');
  }

  const tlyricText = data?.tlyric?.lyric;
  if (typeof tlyricText === 'string' && tlyricText.trim()) {
    const linesWithTranslation = alignTranslationToLines(baseDocument.lines, tlyricText);
    return createLyricDocument({
      source: 'netease',
      format: 'lrc',
      lines: linesWithTranslation,
      providerMeta,
    });
  }

  return baseDocument;
}

export async function searchNeteaseSelections(song, signal, {
  fetchImpl = (url, init) => fetch(url, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const title = String(song?.title || song?.name || '').trim();
  const primaryArtist = splitArtistKeys(song?.artist)[0];
  if (!title || !primaryArtist) {
    throw new LyricSourceError('invalid', 'netease', 'search', 'netease matching requires title and primary artist');
  }

  let firstError = null;
  for (const keyword of buildNeteaseSearchKeywords(song)) {
    try {
      const urls = [
        `https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=10`,
        `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=10`,
      ];
      let searchData = null;
      let lastEndpointError = null;
      for (const url of urls) {
        try {
          const data = await fetchNeteaseJson(fetchImpl, url, { stage: 'search', timeoutMs, signal });
          if (data?.code === 200) {
            searchData = data;
            break;
          }
          if (data?.code === 404) {
            lastEndpointError = new LyricSourceError('unavailable', 'netease', 'search', 'netease search returned 404');
            break;
          }
          lastEndpointError = new LyricSourceError('upstream', 'netease', 'search', `netease search returned code ${data?.code}`);
        } catch (error) {
          if (error instanceof LyricSourceError && error.kind === 'aborted') throw error;
          lastEndpointError = error;
        }
      }
      if (!searchData) {
        if (lastEndpointError) throw lastEndpointError;
        continue;
      }

      const rawSongs = Array.isArray(searchData?.result?.songs) ? searchData.result.songs : [];
      const candidates = rawSongs.map((rawSong) => {
        const artistName = Array.isArray(rawSong?.artists)
          ? rawSong.artists.map((a) => a?.name).filter(Boolean).join(' / ')
          : (Array.isArray(rawSong?.ar)
            ? rawSong.ar.map((a) => a?.name).filter(Boolean).join(' / ')
            : (rawSong?.artist || ''));
        const albumName = typeof rawSong?.album?.name === 'string'
          ? rawSong.album.name
          : (typeof rawSong?.al?.name === 'string'
            ? rawSong.al.name
            : (typeof rawSong?.album === 'string' ? rawSong.album : ''));
        const duration = rawSong?.duration ?? rawSong?.dt;
        return {
          ...rawSong,
          name: rawSong?.name || '',
          artistName,
          albumName,
          duration,
        };
      });

      const selections = rankLyricCandidates(candidates, song, NETEASE_RANKING_OPTIONS)
        .filter((selection) => (
          selection.candidate?.id !== undefined
          && selection.candidate?.id !== null
          && String(selection.candidate.id)
        ));

      if (selections.length > 0) return selections;
    } catch (error) {
      if (error instanceof LyricSourceError && error.kind === 'unavailable') {
        firstError ??= error;
        continue;
      }
      throw error;
    }
  }

  if (firstError) throw firstError;
  return [];
}

export async function loadNeteaseSelection(selection, signal, {
  fetchImpl = (url, init) => fetch(url, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const candidateId = selection?.candidate?.id;
  if (candidateId === undefined || candidateId === null || !String(candidateId)) {
    throw new LyricSourceError('invalid', 'netease', 'load', 'selection missing candidate id');
  }

  const providerMeta = createProviderMeta('netease', selection.candidate, selection);
  const url = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(String(candidateId))}&lv=1&kv=1&tv=1`;
  const lyricData = await fetchNeteaseJson(fetchImpl, url, { stage: 'download-lyric', timeoutMs, signal });

  if (lyricData?.code !== undefined && lyricData.code !== 200) {
    if (lyricData.code === 404) {
      throw new LyricSourceError('unavailable', 'netease', 'download-lyric', 'Netease lyric not found');
    }
    throw new LyricSourceError('upstream', 'netease', 'download-lyric', `Netease lyric returned code ${lyricData.code}`);
  }

  return parseNeteaseLyricDocument(lyricData, { providerMeta });
}
