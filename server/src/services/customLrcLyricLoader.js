import { fetchLimitedJson } from './lyricSourceHttp.js';
import { LyricSourceError } from './lyricSourceError.js';
import {
  createProviderMeta,
  normalizeDurationSeconds,
  rankLyricCandidates,
  splitArtistKeys,
  splitArtistLabels,
  stripCustomKrcTitleSuffixes,
} from './lyricSourceMatching.js';
import {
  createLyricDocument,
  parseLrcDocument,
} from '../utils/lyricDocument.js';
import { isNonLyricText } from '../utils/lyricsParsing.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const LRC_TIMESTAMP_REGEX = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LRC_METADATA_REGEX = /^\[[A-Za-z][\w-]*:/;

const CUSTOM_LRC_RANKING_OPTIONS = Object.freeze({
  titleKeys: ['name', 'song', 'songname', 'trackName'],
  artistKeys: ['artistName', 'singer', 'singername'],
  albumKeys: ['albumName', 'album', 'album_name'],
  durationKeys: ['duration'],
});

const fetchCustomLrcJson = (fetchImpl, url, options) => fetchLimitedJson(fetchImpl, url, { ...options, provider: 'custom_lrc' });

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

export function buildCustomLrcSearchKeywords(song) {
  const title = String(song?.title || song?.name || '').trim();
  if (!title) return [];
  const artist = String(song?.artist || '').trim();
  const artistLabels = splitArtistLabels(artist);
  const primaryArtist = artistLabels[0] || '';
  const cleanTitle = stripCustomKrcTitleSuffixes(title) || title;

  const variants = [
    artist ? `${title} ${artist}` : title,
    primaryArtist && primaryArtist !== artist ? `${title} ${primaryArtist}` : '',
    cleanTitle !== title && artist ? `${cleanTitle} ${artist}` : '',
    cleanTitle !== title && primaryArtist ? `${cleanTitle} ${primaryArtist}` : '',
    title,
  ].filter(Boolean);

  return [...new Set(variants.map((v) => v.trim()).filter(Boolean))].slice(0, 4);
}

export function parseCustomLrcLyricDocument(data, { providerMeta } = {}) {
  const lrcText = data?.lrc?.lyric;
  if (!lrcText || typeof lrcText !== 'string' || !lrcText.trim()
    || data?.nolyric === true || data?.uncollected === true) {
    throw new LyricSourceError('unavailable', 'custom_lrc', 'lyrics', 'CustomLrc song has no lyrics');
  }

  const baseDocument = parseLrcDocument(lrcText, { source: 'custom_lrc', format: 'lrc', providerMeta });
  if (!baseDocument.lines || baseDocument.lines.length === 0) {
    throw new LyricSourceError('unavailable', 'custom_lrc', 'lyrics', 'CustomLrc lyric contains no valid lines');
  }

  const tlyricText = data?.tlyric?.lyric;
  if (typeof tlyricText === 'string' && tlyricText.trim()) {
    const linesWithTranslation = alignTranslationToLines(baseDocument.lines, tlyricText);
    return createLyricDocument({
      source: 'custom_lrc',
      format: 'lrc',
      lines: linesWithTranslation,
      providerMeta,
    });
  }

  return baseDocument;
}

export async function searchCustomLrcSelections(song, signal, {
  fetchImpl = (url, init) => fetch(url, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  config,
  requestBudget,
} = {}) {
  if (!config?.enabled) throw new LyricSourceError('unavailable', 'custom_lrc', 'config', 'Lyric source is disabled');
  const title = String(song?.title || song?.name || '').trim();
  const primaryArtist = splitArtistKeys(song?.artist)[0];
  if (!title || !primaryArtist) {
    throw new LyricSourceError('invalid', 'custom_lrc', 'search', 'custom_lrc matching requires title and primary artist');
  }

  let firstError = null;
  for (const keyword of buildCustomLrcSearchKeywords(song)) {
    try {
      const searchUrl = new URL(config.searchUrl);
      searchUrl.search = new URLSearchParams({ s: keyword, type: '1', offset: '0', limit: '10' });
      const urls = [searchUrl.href];
      let searchData = null;
      let lastEndpointError = null;
      for (const url of urls) {
        try {
          const data = await fetchCustomLrcJson(fetchImpl, url, { stage: 'search', timeoutMs, signal, requestBudget });
          if (data?.code === 200) {
            searchData = data;
            break;
          }
          if (data?.code === 404) {
            lastEndpointError = new LyricSourceError('unavailable', 'custom_lrc', 'search', 'custom_lrc search returned 404');
            break;
          }
          lastEndpointError = new LyricSourceError('upstream', 'custom_lrc', 'search', `custom_lrc search returned code ${data?.code}`);
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

      const selections = rankLyricCandidates(candidates, song, CUSTOM_LRC_RANKING_OPTIONS)
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

export async function loadCustomLrcSelection(selection, signal, {
  fetchImpl = (url, init) => fetch(url, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  config,
  requestBudget,
} = {}) {
  if (!config?.enabled) throw new LyricSourceError('unavailable', 'custom_lrc', 'config', 'Lyric source is disabled');
  const candidateId = selection?.candidate?.id;
  if (candidateId === undefined || candidateId === null || !String(candidateId)) {
    throw new LyricSourceError('invalid', 'custom_lrc', 'load', 'selection missing candidate id');
  }

  const providerMeta = createProviderMeta('custom_lrc', selection.candidate, selection);
  const url = new URL(config.downloadUrl);
  url.search = new URLSearchParams({ id: String(candidateId), lv: '1', kv: '1', tv: '1' });
  const lyricData = await fetchCustomLrcJson(fetchImpl, url.href, { stage: 'download-lyric', timeoutMs, signal, requestBudget });

  if (lyricData?.code !== undefined && lyricData.code !== 200) {
    if (lyricData.code === 404) {
      throw new LyricSourceError('unavailable', 'custom_lrc', 'download-lyric', 'CustomLrc lyric not found');
    }
    throw new LyricSourceError('upstream', 'custom_lrc', 'download-lyric', `CustomLrc lyric returned code ${lyricData.code}`);
  }

  return parseCustomLrcLyricDocument(lyricData, { providerMeta: { ...providerMeta, translationLanguage: config.translationLanguage } });
}
