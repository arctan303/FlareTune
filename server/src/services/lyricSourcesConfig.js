import { DEFAULT_LYRIC_SOURCES, normalizeLyricSources } from '../../../shared/lyricSources.js';
import { createLyricSourceLoader, createCachedSourceDocumentFetcher, createSingleFlightDocumentFetcher, lyricSourceCacheRevision } from './lyricSourceLoader.js';

const loaders = new WeakMap();
export async function loadLyricSources(db) {
  const row = db?.prepare ? await db.prepare("SELECT value_json FROM instance_settings WHERE key = 'lyrics.sources'").first() : null;
  try { return normalizeLyricSources(row?.value_json ? JSON.parse(row.value_json) : DEFAULT_LYRIC_SOURCES); }
  catch { throw new Error('LYRIC_SOURCES_UNAVAILABLE'); }
}
export async function lyricSourceLoaderForDb(db) {
  const sources = await loadLyricSources(db);
  const signature = JSON.stringify(sources);
  const previous = db && loaders.get(db);
  if (previous?.signature === signature) return previous.loader;
  const loader = createLyricSourceLoader({ sources });
  // Each database/configuration owns its cache and circuit state.
  const cached = createCachedSourceDocumentFetcher(createSingleFlightDocumentFetcher(loader.fetchSourceDocument));
  loader.cachedDocument = (source, song, options = {}) => cached(source, song, { ...options, cacheScope: lyricSourceCacheRevision() });
  if (db) loaders.set(db, { signature, loader });
  return loader;
}
