export function hasPreviewOverflow({ renderedCount = 0, visibleCount = renderedCount, totalCount, hasMore = false, scrollOverflow = false }) {
  return Boolean(hasMore || scrollOverflow
    || renderedCount > visibleCount
    || (Number.isFinite(totalCount) && totalCount > visibleCount));
}
