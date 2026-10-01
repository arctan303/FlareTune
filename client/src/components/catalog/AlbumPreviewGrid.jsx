import React from 'react';
import CollectionCard from './CollectionCard.jsx';
import { albumColumnsForWidth, albumGridLayout } from './albumGridLayout.js';

export default function AlbumPreviewGrid({ albums, onOpen, onVisibleCountChange, maxRows = 2, renderCard }) {
  const containerRef = React.useRef(null);
  const [availableColumns, setAvailableColumns] = React.useState(2);

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const update = () => {
      const width = element.clientWidth;
      if (width === 0) return;
      setAvailableColumns(albumColumnsForWidth(width));
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

  const { visibleCount, columns, maxWidth } = albumGridLayout(availableColumns, albums.length, maxRows);

  React.useLayoutEffect(() => {
    onVisibleCountChange?.(visibleCount);
  }, [onVisibleCountChange, visibleCount]);

  return <div ref={containerRef} className="album-preview-grid">
    <div className="album-preview-grid__items" style={{
      gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`,
      maxWidth,
    }}>
      {albums.slice(0, visibleCount).map((album) => renderCard ? renderCard(album) : <CollectionCard key={album.id} kind="album" item={album} onOpen={onOpen} />)}
    </div>
  </div>;
}
