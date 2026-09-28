import { t } from '../../i18n/index.js';
import React from 'react';
import LazyImage from '../LazyImage.jsx';
import PlaylistCover from '../PlaylistCover.jsx';
import { resolveCoverUrl } from '../../utils.js';

export default function CollectionCard({ kind, item, songsMap, onOpen, onPrefetch, isOpening = false }) {
  const isPlaylist = kind === 'playlist';
  const title = isPlaylist && item.kind === 'favorite' ? t('我的收藏') : isPlaylist ? item.name : item.title;
  const meta = isPlaylist ? t('{p0} 首', { p0: item.songCount || 0 }) : item.artist;
  return (
    <button type="button" className={`record-card collection-card group cursor-pointer ${isOpening ? 'is-opening' : ''}`}
      onClick={(event) => onOpen?.(item, event)}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') onPrefetch?.(item); }}
      onPointerDown={() => onPrefetch?.(item)} onFocus={() => onPrefetch?.(item)}
      data-playlist-id={isPlaylist ? item.id : undefined}
      aria-busy={isOpening} aria-label={t("打开{p0} {p1}", { p0: (isPlaylist ? t("歌单") : t("专辑")), p1: (title) })}>
      <div className="record-card__cover mb-3 overflow-hidden rounded-xl">
        {isPlaylist ? <PlaylistCover playlist={item} songsMap={songsMap} /> : (
          <div className="aspect-square overflow-hidden rounded-xl bg-[var(--surface-raised)]">
            <LazyImage src={resolveCoverUrl(item.coverUrl)} fallback="/placeholder-album.svg"
              alt={t("{p0} 专辑封面", { p0: (title) })} className="h-full w-full object-cover" />
          </div>
        )}
      </div>
      <h3 className="record-card__title truncate text-sm font-semibold">{title}</h3>
      <p className="record-card__meta mt-1 truncate text-xs">{meta}</p>
      {isOpening && <span className="record-card__opening" role="status">{t("正在打开")}</span>}
    </button>
  );
}
