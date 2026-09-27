import React from 'react';
import PageBackButton from '../PageBackButton.jsx';

export default function CollectionDetailPage({ kind, title, subtitle, cover, actions, children, onBack }) {
  return (
    <div className="app-page collection-detail-page max-w-6xl mx-auto pb-24">
      <PageBackButton onClick={onBack} className="mb-7" />
      <header className="collection-detail-page__header flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:gap-8">
        <div className="collection-detail-page__cover w-48 h-48 sm:w-60 sm:h-60 shrink-0 overflow-hidden rounded-xl bg-[var(--surface-raised)]">
          {cover}
        </div>
        <div className="min-w-0 flex-1 self-center">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{kind}</p>
          <h1 className="text-3xl sm:text-4xl font-bold text-[var(--ink)] break-words">{title}</h1>
          {subtitle && <p className="mt-3 text-sm text-[var(--muted)]">{subtitle}</p>}
          {actions && <div className="mt-6 flex flex-wrap items-center gap-3">{actions}</div>}
        </div>
      </header>
      <div className="mt-10">{children}</div>
    </div>
  );
}
