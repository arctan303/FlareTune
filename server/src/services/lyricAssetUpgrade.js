import { createRequestSingleFlight } from '../utils/sharedRequestTask.js';
import { fetchLyricsDocumentWithFallback, fetchUncachedSourceLyricsDocument, resolveLyricSourceOrder } from './lyricSourceLoader.js';
import { preferredAutomaticDocument, reliableAutomaticMatch, documentQuality } from './lyricAutomaticSelection.js';

export const LYRIC_UPGRADE_INTERVAL_MS = 6 * 60 * 60_000;
export const LYRIC_UPGRADE_SEARCH_BUDGET_MS = 20_000;
const flights = new WeakMap();

// Reserve the rest of Workers' post-response lifetime for validation and CAS.
// A slow provider must not discard results already returned by another one.
export async function fetchUpgradeDocument(song, fetchDocument, { signal, budgetMs = LYRIC_UPGRADE_SEARCH_BUDGET_MS } = {}) {
  if (signal?.aborted || budgetMs <= 0) return null;
  const controller = new AbortController();
  const completed = new Map();
  let finishDeadline;
  const deadline = new Promise(resolve => { finishDeadline = resolve; });
  const onAbort = () => { controller.abort(signal.reason); finishDeadline(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(finishDeadline, budgetMs);
  try {
    const tasks = resolveLyricSourceOrder('auto').map(async provider => {
      const acceptCandidate = document => {
        if (!controller.signal.aborted && document?.source === provider
          && preferredAutomaticDocument(document, completed.get(provider))) completed.set(provider, document);
      };
      try {
        const document = await fetchDocument(provider, song, {
          signal: controller.signal, onAutomaticCandidate: acceptCandidate,
        });
        acceptCandidate(document);
      } catch { /* Keep the existing asset on failure; no negative asset is written. */ }
    });
    await Promise.race([Promise.all(tasks), deadline]);
    controller.abort();
    if (signal?.aborted) return null;
    return fetchLyricsDocumentWithFallback('auto', song, async provider => completed.get(provider) || null);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

function canUpgrade(read, now) {
  const artifact = read?.artifact;
  const checkedAt = Date.parse(read?.automation?.checkedAt);
  return read?.state === 'found' && artifact?.status === 'ready'
    && artifact.original.source !== 'manual' && artifact.original.syncMode !== 'word'
    && artifact.offsetMs === 0 && artifact.aiCompletion?.status !== 'pending'
    && Number.isFinite(checkedAt) && now - checkedAt >= LYRIC_UPGRADE_INTERVAL_MS;
}

function originalDocument(artifact, song) {
  const matchedDuration = Number(artifact.provenance?.matchedDuration);
  const duration = Number(song.duration);
  return { ...artifact.original, providerMeta: { ...artifact.provenance,
    durationDelta: matchedDuration > 0 && duration > 0 ? Math.abs(matchedDuration - duration) : null,
  } };
}

// Response callers retain their read snapshot. Work is owned by waitUntil and
// an object CAS; a later human edit/deletion always wins over this old snapshot.
export function scheduleLyricAssetUpgrade({ store, song, read, executionContext,
  buildArtifact, songStillExists, now = Date.now, fetchDocument = fetchUncachedSourceLyricsDocument,
}) {
  if (!executionContext?.waitUntil || !canUpgrade(read, now())) return null;
  let singleflight = flights.get(store);
  if (!singleflight) { singleflight = createRequestSingleFlight(); flights.set(store, singleflight); }
  const task = singleflight(song.id, async ({ signal }) => {
    const startedAt = Date.now();
    const current = await store.get(song.id);
    if (current.etag !== read.etag || !canUpgrade(current, now())) return { state: 'superseded' };
    const timestamp = new Date(Math.max(now(), Date.parse(current.artifact.updatedAt) + 1)).toISOString();
    const automation = { checkedAt: timestamp };
    // Persist one bounded check per interval, including misses and provider
    // outages. This also changes the document ETag before any external I/O.
    const claim = await store.putIfMatch(song.id, { ...current.artifact, updatedAt: timestamp },
      current.etag, { automation });
    if (claim.state !== 'updated') return { state: 'superseded' };
    const document = await fetchUpgradeDocument(song, fetchDocument, {
      signal, budgetMs: LYRIC_UPGRADE_SEARCH_BUDGET_MS - (Date.now() - startedAt),
    });
    const previous = originalDocument(claim.artifact, song);
    if (!document || !Number.isFinite(document.providerMeta?.durationDelta)
      || !reliableAutomaticMatch(document)
      || documentQuality(document) <= documentQuality(previous)
      || !preferredAutomaticDocument(document, previous)) return { state: 'unchanged' };
    if (songStillExists && !await songStillExists()) return { state: 'song_deleted' };
    const built = await buildArtifact(song, document, { now: now() });
    if (built.artifact.textHash === claim.artifact.textHash
      && built.artifact.original.lines.length === claim.artifact.original.lines.length
      && claim.artifact.translation) {
      built.artifact.translation = claim.artifact.translation;
      built.artifact.aiCompletion = claim.artifact.aiCompletion;
    }
    return store.putIfMatch(song.id, built.artifact, claim.etag, { automation });
  }, { executionContext });
  executionContext.waitUntil(task.catch(() => undefined));
  return task;
}
