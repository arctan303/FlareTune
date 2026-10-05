import React from 'react';
import { t } from '../../i18n/index.js';
import PageBackButton from '../PageBackButton.jsx';
import CatalogSkeleton from './CatalogSkeleton.jsx';

export default function CollectionDetailSkeleton({ onBack }) {
  return <div className="app-page collection-detail-page max-w-6xl mx-auto pb-24">
    <PageBackButton onClick={onBack} className="mb-7" />
    <div role="status" aria-label={t('正在加载专辑…')}>
      <header aria-hidden="true" inert="" className="collection-detail-page__header flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:gap-8">
        <div className="catalog-skeleton__block w-48 h-48 sm:w-60 sm:h-60 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1 self-center space-y-4 w-full">
          <div className="catalog-skeleton__block h-3 w-16" /><div className="catalog-skeleton__block h-9 w-2/3" />
          <div className="catalog-skeleton__block h-3 w-1/3" /><div className="catalog-skeleton__block h-11 w-28" />
        </div>
      </header>
    </div>
    <div className="mt-10"><CatalogSkeleton type="songs" overview={false} trackGridClassName="track-list track-list--detail" /></div>
  </div>;
}
