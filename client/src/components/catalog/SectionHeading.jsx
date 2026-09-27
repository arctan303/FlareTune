import React from 'react';
import { ChevronRight } from 'lucide-react';

export default function SectionHeading({ title, onViewAll, id, className = 'text-xl font-bold text-[var(--ink)]' }) {
  return onViewAll ? (
    <button type="button" id={id} onClick={onViewAll}
      className={`group inline-flex items-center gap-1 ${className} hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]`}
      aria-label={`查看${title}完整列表`}>
      {title}<ChevronRight size={20} aria-hidden="true" className="text-[var(--muted)] group-hover:text-[var(--accent)]" />
    </button>
  ) : <h2 id={id} className={className}>{title}</h2>;
}
