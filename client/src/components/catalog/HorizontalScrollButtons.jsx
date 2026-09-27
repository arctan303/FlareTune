import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

function ScrollChevron() {
  return <svg width="21" height="48" viewBox="0 0 30 56" fill="none" aria-hidden="true">
    <path d="M10 7 L20 27 Q20.5 28 20 29 L10 49" stroke="currentColor" strokeWidth="4"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export default function HorizontalScrollButtons({ canScroll, onMove, label, variant = 'overlay' }) {
  if (variant === 'header') return <div className="collection-section__actions flex items-center gap-1.5 shrink-0"
    aria-label={`${label}翻页控制`}>
    {[-1, 1].map((direction) => <button key={direction} type="button"
      disabled={direction < 0 ? !canScroll.left : !canScroll.right} onClick={() => onMove(direction)}
      className="w-8 h-8 rounded-full flex items-center justify-center bg-[var(--surface)] hover:bg-[var(--surface-raised)] border border-[var(--line)] text-[var(--ink)] disabled:opacity-25 disabled:cursor-not-allowed transition-all shadow-2xs cursor-pointer"
      aria-label={`向${direction < 0 ? '左' : '右'}滚动${label}`}>
      {direction < 0 ? <ChevronLeft size={16} strokeWidth={2.2} /> : <ChevronRight size={16} strokeWidth={2.2} />}
    </button>)}
  </div>;

  return <>
    {[-1, 1].map((direction) => (direction < 0 ? canScroll.left : canScroll.right)
      && <button key={direction} type="button"
        className={`song-column-shelf__arrow song-column-shelf__arrow--${direction < 0 ? 'left' : 'right'}`}
        onClick={() => onMove(direction)} aria-label={`向${direction < 0 ? '左' : '右'}滚动${label}`}>
        <ScrollChevron />
      </button>)}
  </>;
}
