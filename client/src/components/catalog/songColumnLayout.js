export const CONTENT_SHELF_WIDTH = 430;
export const CONTENT_SHELF_GAP = 28;

export function songColumnWidthForViewport(width) {
  // Wider viewports reveal subsequent columns instead of stretching existing rows.
  return Math.max(0, Math.min(CONTENT_SHELF_WIDTH, Math.floor(width)));
}
