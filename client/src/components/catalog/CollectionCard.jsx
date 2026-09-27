import React from 'react';
import LazyImage from '../LazyImage.jsx';
import PlaylistCover from '../PlaylistCover.jsx';
import { resolveCoverUrl } from '../../utils.js';

export default function CollectionCard({ kind, item, songsMap, onOpen, onPrefetch, isOpening = false }) {
  const isPlaylist = kind === 'playlist';
  const title = isPlaylist ? item.name : item.title;
  const meta = isPlaylist ? `${item.songCount || 0} 首` : item.artist;
  return (
    <button type="button" className={`record-card collection-card group cursor-pointer ${isOpening ? 'is-opening' : ''}`}
      onClick={(event) => onOpen?.(item, event)}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') onPrefetch?.(item); }}
      onPointerDown={() => onPrefetch?.(item)} onFocus={() => onPrefetch?.(item)}
      data-playlist-id={isPlaylist ? item.id : undefined}
      aria-busy={isOpening} aria-label={`打开${isPlaylist ? '歌单' : '专辑'} ${title}`}>
      <div className="record-card__cover mb-3 overflow-hidden rounded-xl">
        {isPlaylist ? <PlaylistCover playlist={item} songsMap={songsMap} /> : (
          <div className="aspect-square overflow-hidden rounded-xl bg-[var(--surface-raised)]">
            <LazyImage src={resolveCoverUrl(item.coverUrl)} fallback="/placeholder-album.svg"
              alt={`${title} 专辑封面`} className="h-full w-full object-cover" />
          </div>
        )}
      </div>
      <h3 className="record-card__title truncate text-sm font-semibold">{title}</h3>
      <p className="record-card__meta mt-1 truncate text-xs">{meta}</p>
      {isOpening && <span className="record-card__opening" role="status">正在打开</span>}
    </button>
  );
}
