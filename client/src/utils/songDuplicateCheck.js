const normalized = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase()
  .replace(/[\p{P}\p{S}\s]/gu, '');
const seconds = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

export function compareSongIdentity(candidate, existing) {
  const title = normalized(candidate.title);
  if (!title || title !== normalized(existing.title)) return null;
  const artist = normalized(candidate.artist);
  const existingArtist = normalized(existing.artist);
  if (artist && existingArtist && artist !== existingArtist) return null;
  const candidateDuration = seconds(candidate.duration);
  const existingDuration = seconds(existing.duration);
  const closeDuration = candidateDuration !== null && existingDuration !== null
    && Math.abs(candidateDuration - existingDuration) <= 3;
  if (!artist || !existingArtist) {
    const album = normalized(candidate.album);
    if (!closeDuration && (!album || album !== normalized(existing.album))) return null;
    return 'possible';
  }
  return closeDuration ? 'strong' : 'possible';
}

export function findQueueDuplicates(candidate, entries, currentKey) {
  const currentIndex = entries.findIndex((entry) => entry.key === currentKey);
  if (currentIndex < 0) return [];
  return entries.slice(0, currentIndex).flatMap((entry) => {
    const strength = compareSongIdentity(candidate, entry.draft);
    return strength ? [{ source: 'queue', key: entry.key, strength, ...entry.draft }] : [];
  });
}

async function collectSongs(query, listSongs) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const data = await listSongs({ page, q: query });
    result.push(...data.songs);
    if (data.total > 300) throw new Error('同名搜索结果过多，无法自动完成查重');
    if (result.length >= data.total || !data.songs.length) return result;
  }
}

export async function findCatalogDuplicates(candidate, listSongs) {
  const title = String(candidate.title || '').trim();
  if (!title) return [];
  const full = await collectSongs(Array.from(title).slice(0, 120).join(''), listSongs);
  const matches = full.flatMap((song) => {
    const strength = compareSongIdentity(candidate, song);
    return strength ? [{ source: 'catalog', strength, ...song }] : [];
  });
  if (matches.length || Array.from(title).length <= 4) return matches;
  const prefix = Array.from(title).slice(0, 4).join('');
  const nearby = await collectSongs(prefix, listSongs);
  return nearby.flatMap((song) => {
    const strength = compareSongIdentity(candidate, song);
    return strength ? [{ source: 'catalog', strength, ...song }] : [];
  });
}
