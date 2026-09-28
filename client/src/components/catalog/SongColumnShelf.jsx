import { t } from '../../i18n/index.js';
import React from 'react';
import HorizontalScrollButtons from './HorizontalScrollButtons.jsx';
import { horizontalScrollState, moveHorizontalScroll } from './horizontalScroll.js';

const COLUMN_GAP = 34;
const MIN_COLUMN_WIDTH = 350;
const NEXT_COLUMN_REVEAL = COLUMN_GAP + 28;
const MAX_VISIBLE_COLUMNS = 4;

export default function SongColumnShelf({ label = '歌曲', children, onOverflowChange }) {
  const containerRef = React.useRef(null);
  const viewportRef = React.useRef(null);
  const previousPitchRef = React.useRef(MIN_COLUMN_WIDTH + COLUMN_GAP);
  const [layout, setLayout] = React.useState({ rows: 4, columnWidth: MIN_COLUMN_WIDTH });
  const [scrollState, setScrollState] = React.useState({ left: false, right: false });
  const items = React.Children.toArray(children);
  const columns = Array.from({ length: Math.ceil(items.length / layout.rows) }, (_, index) =>
    items.slice(index * layout.rows, (index + 1) * layout.rows));

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
      const rows = 4;
      const visible = Math.max(1, Math.min(MAX_VISIBLE_COLUMNS,
        Math.floor((width + COLUMN_GAP - NEXT_COLUMN_REVEAL) / (MIN_COLUMN_WIDTH + COLUMN_GAP))));
      const columnWidth = Math.max(240,
        Math.floor((width - (visible - 1) * COLUMN_GAP - NEXT_COLUMN_REVEAL) / visible));
      setLayout((previous) => previous.rows === rows && previous.columnWidth === columnWidth
        ? previous : { rows, columnWidth });
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
  }, [items.length, layout.rows, layout.columnWidth, updateScrollState]);

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextPitch = layout.columnWidth + COLUMN_GAP;
    const column = Math.round(viewport.scrollLeft / previousPitchRef.current);
    previousPitchRef.current = nextPitch;
    viewport.scrollLeft = column * nextPitch;
    updateScrollState();
  }, [layout.columnWidth, updateScrollState]);

  const move = (direction) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    moveHorizontalScroll(viewport, direction, layout.columnWidth + COLUMN_GAP);
  };

  return <div ref={containerRef} className="song-column-shelf">
    <div ref={viewportRef} className="song-column-shelf__viewport" onScroll={updateScrollState}
      tabIndex={0} role="region" aria-label={t("{p0}预览，横向滚动查看更多", { p0: (label) })}>
      <div className="song-column-shelf__columns" style={{
        '--song-column-width': `${layout.columnWidth}px`,
        '--song-column-end-space': `${NEXT_COLUMN_REVEAL}px`,
      }}>
        {columns.map((column, index) => <div key={index} className="song-column-shelf__column">{column}</div>)}
      </div>
    </div>
    <HorizontalScrollButtons canScroll={scrollState} onMove={move} label={label} />
  </div>;
}
