const VERSION_PATTERNS = Object.freeze({
  dj: /\bdj\b|dj版/iu,
  live: /\blive\b|现场(?:版)?|演唱会(?:版)?/iu,
  remix: /\bremix(?:ed)?\b|混音(?:版)?/iu,
  instrumental: /伴奏(?:版)?|纯音乐(?:版)?|instrumental/iu,
  sped: /sped\s*up|加速(?:版)?|快版/iu,
  slowed: /slowed(?:\s*down)?|慢速(?:版)?|慢版/iu,
  cover: /\bcover\b|翻唱(?:版)?/iu,
  acoustic: /\bacoustic\b|不插电(?:版)?/iu,
  remaster: /\bremaster(?:ed)?\b|重制(?:版)?/iu,
});

const TRAILING_TITLE_GROUP = /\s*[（(【\[][^）)】\]]{1,120}[）)】\]]\s*$/u;

export const normalizeComparable = (value) => String(value || '')
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/&(?:amp|#0*38);/giu, '&')
  .replace(/[^\p{L}\p{N}]+/gu, '');

export const versionQualifiers = (value) => new Set(
  Object.entries(VERSION_PATTERNS)
    .filter(([, pattern]) => pattern.test(String(value || '')))
    .map(([key]) => key),
);

export const hasVersionMismatch = (requestedTitle, actualText) => {
  const requested = versionQualifiers(requestedTitle);
  const actual = versionQualifiers(actualText);
  return [...actual].some((v) => !requested.has(v));
};

const stripVersionQualifiers = (value) => {
  let stripped = String(value || '');
  for (const pattern of Object.values(VERSION_PATTERNS)) stripped = stripped.replace(pattern, ' ');
  return stripped.replace(/[（(【\[]\s*(?:版|version)?\s*[）)】\]]/giu, ' ');
};

export function stripKugouTitleSuffixes(value) {
  let title = String(value || '').trim();
  let previous = '';
  while (title && title !== previous && TRAILING_TITLE_GROUP.test(title)) {
    previous = title;
    title = title.replace(TRAILING_TITLE_GROUP, '').trim();
  }
  title = stripVersionQualifiers(title)
    .replace(/\s*[-–—]\s*(?:live|remix(?:ed)?|instrumental|acoustic|remaster(?:ed)?|现场版?|混音版?|伴奏版?|重制版?)\s*$/giu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return title;
}

const titleIdentityKeys = (value) => new Set([
  normalizeComparable(stripVersionQualifiers(value)),
  normalizeComparable(stripKugouTitleSuffixes(value)),
].filter(Boolean));

export const splitArtistKeys = (value) => String(value || '')
  .split(/\s*(?:\/|、|,|，|&|；|;|\+|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b|\bx\b)\s*/giu)
  .map(normalizeComparable)
  .filter(Boolean);

export const splitArtistLabels = (value) => String(value || '')
  .split(/\s*(?:\/|、|,|，|&|；|;|\+|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b|\bx\b)\s*/giu)
  .map((artist) => artist.trim())
  .filter(Boolean);

const TITLE_FEAT_PATTERN = /[\(（\[【]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^\)）\]】]+)[\)）\]】]/iu;

export function extractTitleFeaturedArtists(title) {
  const match = String(title || '').match(TITLE_FEAT_PATTERN);
  if (!match) return [];
  return splitArtistLabels(match[1].replace(/\band\b/giu, ','));
}

export const normalizeDurationSeconds = (value) => {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return duration > 10_000 ? duration / 1_000 : duration;
};

export const candidateValue = (candidate, keys) => {
  for (const key of keys) {
    if (candidate?.[key] !== undefined && candidate[key] !== null) return candidate[key];
  }
  return '';
};

export function scoreLyricCandidate(candidate, song, {
  titleKeys = ['song', 'songname', 'trackName', 'name'],
  artistKeys = ['singer', 'singername', 'artistName'],
  albumKeys = ['album', 'album_name', 'albumName'],
  durationKeys = ['duration'],
} = {}) {
  const requestedTitle = String(song?.title || song?.name || '');
  const candidateTitle = String(candidateValue(candidate, titleKeys));
  const requestedTitleKeys = titleIdentityKeys(requestedTitle);
  const candidateTitleKeys = titleIdentityKeys(candidateTitle);
  if (requestedTitleKeys.size === 0 || candidateTitleKeys.size === 0
    || ![...requestedTitleKeys].some((key) => candidateTitleKeys.has(key))) return null;

  const exactTitle = normalizeComparable(requestedTitle) === normalizeComparable(candidateTitle);
  const requestedVersions = versionQualifiers(requestedTitle);
  const candidateVersions = versionQualifiers(candidateTitle);
  const versionMismatch = requestedVersions.size !== candidateVersions.size
    || [...requestedVersions].some((value) => !candidateVersions.has(value));

  const requestedArtists = splitArtistKeys(song?.artist);
  const candidateArtists = splitArtistKeys(candidateValue(candidate, artistKeys));
  if (requestedArtists.length === 0) return null;
  if (candidateArtists.length === 0 || !candidateArtists.includes(requestedArtists[0])) return null;
  let artistRatio = 1;
  let unexpectedArtistCount = 0;
  const matchedArtists = requestedArtists.filter((artist) => candidateArtists.includes(artist));
  artistRatio = matchedArtists.length / requestedArtists.length;
  unexpectedArtistCount = candidateArtists.filter((artist) => !requestedArtists.includes(artist)).length;

  const requestedDuration = normalizeDurationSeconds(song?.duration);
  const candidateDuration = normalizeDurationSeconds(candidateValue(candidate, durationKeys));
  const durationDelta = requestedDuration === null || candidateDuration === null
    ? null
    : Math.abs(requestedDuration - candidateDuration);
  const requestedAlbum = normalizeComparable(song?.album);
  const candidateAlbum = normalizeComparable(candidateValue(candidate, albumKeys));
  const albumMatch = Boolean(requestedAlbum && candidateAlbum && requestedAlbum === candidateAlbum);
  const durationScore = computeDurationScore(durationDelta);
  const versionPenalty = versionMismatch
    ? (durationDelta !== null && durationDelta > 15 ? 50 : 15)
    : 0;
  const score = 100 + (artistRatio * 40) + (albumMatch ? 10 : 0) + durationScore
    + (exactTitle ? 10 : 0) - versionPenalty - (unexpectedArtistCount * 5);
  return {
    candidate,
    score,
    durationDelta,
    exactTitle,
    artistRatio,
    albumMatch,
    versionMismatch,
  };
}

export function computeDurationScore(durationDelta) {
  if (durationDelta === null || durationDelta === undefined || !Number.isFinite(durationDelta)) {
    return 0;
  }
  const delta = Math.max(0, durationDelta);
  if (delta <= 3) {
    return 25 - (delta * 0.8);
  }
  if (delta <= 15) {
    return 22.6 - ((delta - 3) * 0.7);
  }
  if (delta <= 35) {
    return 14.2 - ((delta - 15) * 0.4);
  }
  if (delta <= 60) {
    return Math.max(0, 6.2 - ((delta - 35) * 0.248));
  }
  return 0;
}

export function rankLyricCandidates(candidates, song, options) {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((candidate) => scoreLyricCandidate(candidate, song, options))
    .filter(Boolean)
    .sort((left, right) => (
      right.score - left.score
      || (left.durationDelta ?? Number.POSITIVE_INFINITY)
        - (right.durationDelta ?? Number.POSITIVE_INFINITY)
    ));
}

const formatKugouKeyword = (artist, title) => (artist ? `${artist}-${title}` : title);

export function buildKugouSearchKeywords(song) {
  const title = String(song?.title || song?.name || '').trim();
  if (!title) return [];
  const simplifiedTitle = stripKugouTitleSuffixes(title) || title;
  const artist = String(song?.artist || '').trim();
  const artistLabels = splitArtistLabels(artist);
  const primaryArtist = artistLabels[0] || '';
  const featArtists = extractTitleFeaturedArtists(title);
  const combinedArtists = [...new Set([...artistLabels, ...featArtists])];
  const normalizedArtists = artistLabels.join('、');
  const normalizedCombined = combinedArtists.join('、');
  const variants = [
    formatKugouKeyword(artist, title),
    formatKugouKeyword(artist, simplifiedTitle),
    formatKugouKeyword(normalizedArtists, simplifiedTitle),
    formatKugouKeyword(artistLabels[0] || '', simplifiedTitle),
    ...(combinedArtists.length > artistLabels.length ? [
      formatKugouKeyword(normalizedCombined, simplifiedTitle),
      formatKugouKeyword(combinedArtists.slice(0, 2).join('、'), simplifiedTitle),
      ...featArtists.map((feat) => formatKugouKeyword(feat, simplifiedTitle)),
    ] : []),
  ];
  return [...new Set(variants.map((value) => value.trim()).filter(Boolean))].slice(0, 6);
}

export function buildKugouSearchKeyword(song) {
  return buildKugouSearchKeywords(song)[0] || '';
}

export function buildKugouDurationMsCandidates(duration) {
  const norm = normalizeDurationSeconds(duration);
  if (norm === null) return [null];
  const floorSec = Math.floor(norm);
  const roundSec = Math.round(norm);
  if (floorSec !== roundSec) {
    return [String(floorSec * 1_000), String(roundSec * 1_000)];
  }
  return [String(floorSec * 1_000)];
}

export const createProviderMeta = (provider, candidate, score) => ({
  providerLyricId: candidate?.id === undefined ? undefined : String(candidate.id),
  matchedTitle: String(candidateValue(candidate, provider === 'kugou'
    ? ['song', 'songname']
    : ['trackName', 'name'])),
  matchedArtist: String(candidateValue(candidate, provider === 'kugou'
    ? ['singer', 'singername']
    : ['artistName'])),
  matchedDuration: normalizeDurationSeconds(candidateValue(candidate, ['duration'])),
  durationDelta: score?.durationDelta,
  ...(score?.versionMismatch ? { versionMismatch: true } : {}),
});

export const createSafeCandidateDto = (provider, selection) => {
  const candidate = selection?.candidate;
  const providerLyricId = candidate?.id === undefined || candidate?.id === null
    ? ''
    : String(candidate.id);
  if (!providerLyricId) return null;
  return {
    source: provider,
    providerLyricId,
    matchedTitle: String(candidateValue(candidate, provider === 'kugou'
      ? ['song', 'songname']
      : ['trackName', 'name'])),
    matchedArtist: String(candidateValue(candidate, provider === 'kugou'
      ? ['singer', 'singername']
      : ['artistName'])),
    matchedAlbum: String(candidateValue(candidate, provider === 'kugou'
      ? ['album', 'album_name']
      : ['albumName'])),
    matchedDuration: normalizeDurationSeconds(candidateValue(candidate, ['duration'])),
    durationDelta: selection.durationDelta,
    versionMismatch: selection.versionMismatch,
    score: selection.score,
  };
};

export const createAuditCandidateDto = (provider, selection) => {
  const providerLyricId = selection?.candidate?.id === undefined
    || selection?.candidate?.id === null
    ? ''
    : String(selection.candidate.id);
  if (!providerLyricId) return null;
  return {
    source: provider,
    providerLyricId,
    durationDelta: selection.durationDelta,
    score: selection.score,
  };
};
