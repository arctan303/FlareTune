import React from 'react';
import { t } from '../../i18n/index.js';
import SongColumnShelf from './SongColumnShelf.jsx';
import ArtistPreviewRow from './ArtistPreviewRow.jsx';
import AlbumPreviewGrid from './AlbumPreviewGrid.jsx';

const slots = Array.from({ length: 20 }, (_, index) => ({ id: `loading-${index}`, name: `loading-${index}` }));
const block = (className = '') => <div className={`catalog-skeleton__block ${className}`} />;
const track = ({ id }) => <div key={id} className="catalog-skeleton__track">
  {block('catalog-skeleton__track-cover')}
  <div className="catalog-skeleton__track-text">{block('catalog-skeleton__title')}{block('catalog-skeleton__subtitle')}</div>
</div>;
const artist = ({ id }) => <div key={id} className="catalog-skeleton__artist">
  {block('catalog-skeleton__avatar')}{block('catalog-skeleton__title')}{block('catalog-skeleton__subtitle')}
</div>;
const album = ({ id }) => <div key={id}>
  {block('catalog-skeleton__album-cover')}{block('catalog-skeleton__title')}{block('catalog-skeleton__subtitle')}
</div>;

export default function CatalogSkeleton({ type, overview = true, trackGridClassName = 'home-track-grid' }) {
  let content;
  if (type === 'songs') content = overview
    ? <SongColumnShelf>{slots.map(track)}</SongColumnShelf>
    : <div className={trackGridClassName}>{slots.map(track)}</div>;
  else if (type === 'artists') content = overview
    ? <ArtistPreviewRow artists={slots.slice(0, 6)} renderCard={artist} />
    : <div className="artist-full-grid">{slots.slice(0, 6).map(artist)}</div>;
  else content = <AlbumPreviewGrid albums={slots.slice(0, 10)} maxRows={overview ? 2 : Infinity} renderCard={album} />;
  return <div className="catalog-skeleton" role="status" aria-label={t("正在加载…")}>
    <div aria-hidden="true" inert="">{content}</div>
  </div>;
}
