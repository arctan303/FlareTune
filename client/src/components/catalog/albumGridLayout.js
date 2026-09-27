export const ALBUM_CARD_MAX_WIDTH = 220;
export const ALBUM_GRID_GAP = 28;

export function albumColumnsForWidth(width) {
  const minimum = width < 600 ? 150 : width < 900 ? 180 : 200;
  return Math.max(1, Math.floor((width + ALBUM_GRID_GAP) / (minimum + ALBUM_GRID_GAP)));
}

export function albumGridLayout(availableColumns, count, maxRows = 2) {
  const visibleCount = Math.min(count, availableColumns * maxRows);
  const columns = Math.max(1, Math.min(visibleCount, availableColumns));
  return {
    visibleCount,
    columns,
    maxWidth: columns * ALBUM_CARD_MAX_WIDTH + (columns - 1) * ALBUM_GRID_GAP,
  };
}
