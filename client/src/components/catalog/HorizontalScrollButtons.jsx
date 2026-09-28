import { t } from '../../i18n/index.js';
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
    aria-label={t("{p0}翻页控制", { p0: (label) })}>
    {[-1, 1].map((direction) => <button key={direction} type="button"
      disabled={direction < 0 ? !canScroll.left : !canScroll.right} onClick={() => onMove(direction)}
      className="w-8 h-8 rounded-full flex items-center justify-center bg-[var(--surface)] hover:bg-[var(--surface-raised)] border border-[var(--line)] text-[var(--ink)] disabled:opacity-25 disabled:cursor-not-allowed transition-all shadow-2xs cursor-pointer"
      aria-label={t("向{p0}滚动{p1}", { p0: t(direction < 0 ? '左' : '右'), p1: label })}>
      {direction < 0 ? <ChevronLeft size={16} strokeWidth={2.2} /> : <ChevronRight size={16} strokeWidth={2.2} />}
    </button>)}
  </div>;

  return <>
    {[-1, 1].map((direction) => (direction < 0 ? canScroll.left : canScroll.right)
      && <button key={direction} type="button"
        className={`song-column-shelf__arrow song-column-shelf__arrow--${direction < 0 ? 'left' : 'right'}`}
        onClick={() => onMove(direction)} aria-label={t("向{p0}滚动{p1}", { p0: t(direction < 0 ? '左' : '右'), p1: label })}>
        <ScrollChevron />
      </button>)}
  </>;
}
