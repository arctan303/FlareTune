import { t } from '../../i18n/index.js';
import React from 'react';
import HorizontalScrollButtons from './HorizontalScrollButtons.jsx';
import { horizontalScrollState, moveHorizontalScroll } from './horizontalScroll.js';
import { songColumnWidthForViewport, CONTENT_SHELF_WIDTH, CONTENT_SHELF_GAP } from './songColumnLayout.js';

const ROWS_PER_COLUMN = 4;

export default function SongColumnShelf({ label = '歌曲', children, onOverflowChange }) {
  const containerRef = React.useRef(null);
  const viewportRef = React.useRef(null);
  const previousPitchRef = React.useRef(CONTENT_SHELF_WIDTH + CONTENT_SHELF_GAP);
  const resizeColumnRef = React.useRef(0);
  const [columnWidth, setColumnWidth] = React.useState(CONTENT_SHELF_WIDTH);
  const [scrollState, setScrollState] = React.useState({ left: false, right: false });
  const items = React.Children.toArray(children);
  const columns = Array.from({ length: Math.ceil(items.length / ROWS_PER_COLUMN) }, (_, index) =>
    items.slice(index * ROWS_PER_COLUMN, (index + 1) * ROWS_PER_COLUMN));

  const updateScrollState = React.useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const { overflow, ...next } = horizontalScrollState(viewport);
    setScrollState((previous) => previous.left === next.left && previous.right === next.right ? previous : next);
    onOverflowChange?.(overflow);
  }, [onOverflowChange]);

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const update = () => {
      const width = element.clientWidth;
      if (width === 0) return;
      // Capture before the DOM changes; scroll snapping can otherwise move scrollLeft
      // to the new pitch before the restoration effect reads the old column index.
      resizeColumnRef.current = Math.round((viewportRef.current?.scrollLeft || 0) / previousPitchRef.current);
      setColumnWidth(songColumnWidthForViewport(width));
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    if (!observer) window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      if (!observer) window.removeEventListener('resize', update);
    };
  }, []);

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    updateScrollState();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollState);
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, [items.length, columnWidth, updateScrollState]);

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextPitch = columnWidth + CONTENT_SHELF_GAP;
    previousPitchRef.current = nextPitch;
    viewport.scrollLeft = resizeColumnRef.current * nextPitch;
    updateScrollState();
  }, [columnWidth, updateScrollState]);

  const move = (direction) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    moveHorizontalScroll(viewport, direction, columnWidth + CONTENT_SHELF_GAP);
  };

  return <div ref={containerRef} className="song-column-shelf">
    <div ref={viewportRef} className="song-column-shelf__viewport" onScroll={updateScrollState}
      tabIndex={0} role="region" aria-label={t("{p0}预览，横向滚动查看更多", { p0: (label) })}>
      <div className="song-column-shelf__columns" style={{
        '--song-column-width': `${columnWidth}px`,
        '--song-column-gap': `${CONTENT_SHELF_GAP}px`,
      }}>
        {columns.map((column, index) => <div key={index} className="song-column-shelf__column">{column}</div>)}
      </div>
    </div>
    <HorizontalScrollButtons canScroll={scrollState} onMove={move} label={label} />
  </div>;
}
