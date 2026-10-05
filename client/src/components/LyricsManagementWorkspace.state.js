const SOURCE_LABELS = Object.freeze({ kugou: '酷狗', netease: '网易云', lrclib: 'LRCLIB' });

const PROVIDER_WARNING_LABELS = Object.freeze({
  circuit_open: '暂时熔断',
  invalid: '返回异常',
  network: '网络异常',
  rate_limited: '请求过快',
  timeout: '请求超时',
  unavailable: '暂时不可用',
  upstream: '上游异常',
});

const CANDIDATE_WARNING_LABELS = Object.freeze({
  no_word_timing: '仅逐行',
  unsynced: '无时间轴',
  version_mismatch: '版本不符',
});

export const LYRICS_WORKSPACE_MOBILE_QUERY = '(max-width: 639px)';

const normalizedSongId = (value) => String(value ?? '');

export function createWorkspaceRequestLifecycle() {
  let generation = 0;
  let isOpen = false;
  let songId = '';
  let controller = null;

  const abortCurrent = () => {
    controller?.abort();
    controller = null;
  };

  return {
    open(nextSongId) {
      abortCurrent();
      generation += 1;
      isOpen = true;
      songId = normalizedSongId(nextSongId);
    },
    close() {
      abortCurrent();
      generation += 1;
      isOpen = false;
      songId = '';
    },
    begin(nextSongId) {
      const requestedSongId = normalizedSongId(nextSongId);
      if (!isOpen || !requestedSongId || requestedSongId !== songId) return null;
      abortCurrent();
      generation += 1;
      controller = new AbortController();
      return { controller, generation, songId: requestedSongId };
    },
    isCurrent(request) {
      return Boolean(
        request
        && isOpen
        && songId === request.songId
        && generation === request.generation
        && !request.controller.signal.aborted
      );
    },
  };
}

export function getWorkspacePaneAccessibility(isMobile, mobileView) {
  const listHidden = Boolean(isMobile && mobileView === 'preview');
  const previewHidden = Boolean(isMobile && mobileView !== 'preview');
  return {
    list: {
      'aria-hidden': listHidden || undefined,
      inert: listHidden ? '' : undefined,
    },
    preview: {
      'aria-hidden': previewHidden || undefined,
      inert: previewHidden ? '' : undefined,
    },
  };
}

export function projectProviderWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  const seen = new Set();
  return warnings.slice(0, 8).flatMap((warning, index) => {
    const source = SOURCE_LABELS[warning?.source] || '某歌词源';
    const detail = PROVIDER_WARNING_LABELS[warning?.code] || '返回未知状态';
    const text = `${source}${detail}`;
    if (seen.has(text)) return [];
    seen.add(text);
    return [{ key: `provider-warning-${index}`, text }];
  });
}

export function projectCandidateWarnings(...warningGroups) {
  const seen = new Set();
  return warningGroups.flatMap((warnings) => (Array.isArray(warnings) ? warnings : []))
    .slice(0, 12)
    .flatMap((warning) => {
      const label = CANDIDATE_WARNING_LABELS[warning] || '质量信息待确认';
      if (seen.has(label)) return [];
      seen.add(label);
      return [label];
    });
}

export function getCandidateQualityTier(inspection) {
  if (inspection?.state !== 'ready') return -1;
  const syncMode = inspection.syncMode
    || inspection.original?.syncMode
    || inspection.document?.syncMode
    || inspection.lyrics?.syncMode
    || 'none';
  const translationAvailable = Boolean(
    inspection.translationAvailable
    || inspection.translation
    || inspection.document?.translationAvailable
    || (Array.isArray(inspection.document?.tlyric) && inspection.document.tlyric.some((l) => String(l || '').trim()))
  );

  if (syncMode === 'word' && translationAvailable) return 4;
  if (syncMode === 'word' && !translationAvailable) return 3;
  if (syncMode === 'line' && translationAvailable) return 2;
  if (syncMode === 'line' && !translationAvailable) return 1;
  if (syncMode === 'none') return 0;
  return -1;
}

export function sortLyricsCandidates(candidates, inspections = {}) {
  if (!Array.isArray(candidates)) return [];
  const candidateKey = (c) => `${c?.source || ''}:${c?.providerLyricId || ''}`;
  const indexed = candidates.map((candidate, index) => ({ candidate, index }));
  indexed.sort((a, b) => {
    const keyA = candidateKey(a.candidate);
    const keyB = candidateKey(b.candidate);
    const matchDifference = getCandidateMatchTier(b.candidate, inspections[keyB])
      - getCandidateMatchTier(a.candidate, inspections[keyA]);
    if (matchDifference) return matchDifference;
    const scoreA = Number(a.candidate?.score);
    const scoreB = Number(b.candidate?.score);
    const hasScoreA = Number.isFinite(scoreA);
    const hasScoreB = Number.isFinite(scoreB);
    if (hasScoreA && hasScoreB && scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    const tierA = getCandidateQualityTier(inspections[keyA]);
    const tierB = getCandidateQualityTier(inspections[keyB]);
    // An unknown body must stay discoverable among equally matched summaries.
    // Use an explicit rank to keep comparison transitive as inspection arrives.
    const rankA = tierA < 0 ? 5 : tierA;
    const rankB = tierB < 0 ? 5 : tierB;
    if (rankA !== rankB) return rankB - rankA;
    return a.index - b.index;
  });
  return indexed.map((item) => item.candidate);
}

export function getCandidateMatchTier(candidate, inspection) {
  if (candidate?.versionMismatch || candidate?.warnings?.includes('version_mismatch')
    || inspection?.warnings?.includes('version_mismatch')) return 0;
  if (candidate?.durationDelta !== null && candidate?.durationDelta !== undefined
    && Number(candidate.durationDelta) > 15) return 1;
  return 2;
}

export function filterLyricsCandidates(candidates, inspections = {}, filter = 'all', translation = 'all') {
  if (!Array.isArray(candidates)) return [];
  if ((!filter || filter === 'all') && translation === 'all') return candidates;
  const candidateKey = (c) => `${c?.source || ''}:${c?.providerLyricId || ''}`;
  return candidates.filter((candidate) => {
    const key = candidateKey(candidate);
    const inspection = inspections[key];
    if (inspection?.state !== 'ready') return false;
    const syncMode = inspection.syncMode
      || inspection.original?.syncMode
      || inspection.document?.syncMode
      || inspection.lyrics?.syncMode
      || 'none';
    const translationAvailable = Boolean(
      inspection.translationAvailable
      || inspection.translation
      || inspection.document?.translationAvailable
      || (Array.isArray(inspection.document?.tlyric) && inspection.document.tlyric.some((l) => String(l || '').trim()))
    );
    if (['word', 'line', 'none'].includes(filter) && syncMode !== filter) return false;
    if (filter === 'translation') return translationAvailable;
    if (translation === 'yes' && !translationAvailable) return false;
    if (translation === 'no' && translationAvailable) return false;
    return true;
  });
}
