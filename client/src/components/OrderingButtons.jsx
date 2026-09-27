import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export default function OrderingButtons({ itemKey, index, total, onMove }) {
  return (
    <span className="account-order-buttons inline-flex items-center gap-0.5">
      <button
        type="button"
        disabled={index === 0}
        onClick={() => onMove(itemKey, -1)}
        aria-label="上移一项"
        className="p-1 text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <ChevronUp size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        disabled={index === total - 1}
        onClick={() => onMove(itemKey, 1)}
        aria-label="下移一项"
        className="p-1 text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <ChevronDown size={15} aria-hidden="true" />
      </button>
    </span>
  );
}
