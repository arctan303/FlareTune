import React from 'react';
import ArtistCard from './ArtistCard.jsx';

const GAP = 24;

function cardWidthFor(containerWidth) {
  if (containerWidth < 600) return 120;
  if (containerWidth < 900) return 140;
  return 160;
}

export default function ArtistPreviewRow({ artists = [], onOpen, onVisibleCountChange }) {
  const containerRef = React.useRef(null);
  const [layout, setLayout] = React.useState({ capacity: 1, cardWidth: 120 });

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const update = () => {
      if (element.clientWidth === 0) return;
      const width = Math.max(0, element.clientWidth - 8);
      const cardWidth = cardWidthFor(width);
      const capacity = Math.max(1, Math.floor((width + GAP) / (cardWidth + GAP)));
      setLayout((previous) => previous.capacity === capacity && previous.cardWidth === cardWidth
        ? previous : { capacity, cardWidth });
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

  const visibleCount = Math.min(artists.length, layout.capacity);
  React.useLayoutEffect(() => {
    onVisibleCountChange?.(visibleCount);
  }, [onVisibleCountChange, visibleCount]);

  return <div ref={containerRef} className="artist-preview-row"
    style={{ '--artist-preview-card-width': `${layout.cardWidth}px` }}>
    {artists.slice(0, visibleCount).map((artist) => (
      <ArtistCard key={artist.name} artist={artist} onOpen={onOpen} />
    ))}
  </div>;
}
