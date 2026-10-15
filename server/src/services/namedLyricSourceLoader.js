import { DEFAULT_LYRIC_SOURCES, normalizeLyricChannels } from '../../../shared/lyricSources.js';
import { createLyricSourceLoader, LyricSourceError } from './lyricSourceLoader.js';
import { createLyricDocument } from '../utils/lyricDocument.js';

// Each configured source owns an adapter (including its circuit state).
// Protocol IDs stay inside the adapter; callers and persisted documents use
// stable source IDs, even when multiple services use the same protocol.
export function createNamedLyricSourceLoader({ channels, ...options }) {
  const config = normalizeLyricChannels(channels);
  const entries = [...config.sources, { id: 'lrclib', name: 'LRCLIB', protocol: 'lrclib', enabled: true }];
  const adapters = new Map(entries.filter(source => source.enabled).map(source => [source.id, {
    source,
    loader: createLyricSourceLoader({ ...options, sources: source.id === 'lrclib'
      ? DEFAULT_LYRIC_SOURCES : { [source.protocol]: {
        enabled: true, searchUrl: source.searchUrl, downloadUrl: source.downloadUrl,
        translationLanguage: source.translationLanguage,
      } } }),
  }]));
  const enabledSources = [...adapters.keys()];
  const sourceDetails = [...adapters.values()].map(({ source }) => ({ id: source.id, name: source.name }));
  const documentFor = (source, document) => document && createLyricDocument({ ...document, source });
  async function sourceRequest(id, request) {
    try { return await request(); }
    catch (error) {
      if (error instanceof LyricSourceError) throw new LyricSourceError(error.kind, id, error.stage, 'Lyric source request failed', { cause: error });
      throw error;
    }
  }
  async function call(id, method, song, options) {
    const entry = adapters.get(id);
    if (!entry) throw new LyricSourceError('unavailable', id, 'config', 'Lyric source is disabled or removed');
    return sourceRequest(id, () => entry.loader[method](entry.source.protocol, song, options));
  }
  const fetchSourceDocument = async (id, song, options = {}) => documentFor(id,
    await call(id, 'fetchSourceDocument', song, { ...options,
      ...(options.onAutomaticCandidate ? { onAutomaticCandidate: candidate => options.onAutomaticCandidate({ ...candidate, source: id }) } : {}),
    }));
  return {
    enabledSources, sourceDetails, fetchSourceDocument,
    listSourceCandidates: async (id, song, options) => (await call(id, 'listSourceCandidates', song, options))
      .map(candidate => ({ ...candidate, source: id })),
    fetchSourceAuditEvidence: async (id, song, options) => {
      const evidence = await call(id, 'fetchSourceAuditEvidence', song, options);
      return { ...evidence, document: documentFor(id, evidence.document),
        candidates: evidence.candidates.map(candidate => ({ ...candidate, source: id })) };
    },
    createCandidateInspectionSnapshot: async (id, song, options) => {
      const snapshot = await call(id, 'createCandidateInspectionSnapshot', song, options);
      return { providerLyricIds: snapshot.providerLyricIds,
        loadDocument: async (...args) => documentFor(id, await sourceRequest(id, () => snapshot.loadDocument(...args))) };
    },
  };
}
