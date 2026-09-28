import { t } from '../../i18n/index.js';
import React from 'react';
import { User } from 'lucide-react';
import LazyImage from '../LazyImage.jsx';
import { resolveCoverUrl } from '../../utils.js';

export default function ArtistCard({ artist, onOpen }) {
  const subtitle = artist.songCount != null
    ? `${artist.songCount} 首歌曲`
    : artist.songs?.length
      ? `${artist.songs.length} 首歌曲`
      : '歌手';

  const cover = artist.photoUrl || artist.coverUrl;

  return (
    <button
      type="button"
      onClick={() => onOpen?.(artist)}
      className="artist-card group relative flex flex-col items-center text-center cursor-pointer select-none border-0 bg-transparent p-0 focus-visible:outline-none"
      aria-label={t("查看歌手 {p0}", { p0: (artist.name) })}
    >
      <div className="artist-card__avatar relative aspect-square w-full max-w-[160px] overflow-hidden rounded-full bg-[var(--surface-raised)] shadow-[0_4px_16px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.35)] transition-all duration-300 ease-out group-hover:shadow-[0_8px_24px_rgba(0,0,0,0.14)] dark:group-hover:shadow-[0_8px_24px_rgba(0,0,0,0.5)] group-hover:-translate-y-1">
        {cover ? (
          <LazyImage
            src={resolveCoverUrl(cover)}
            fallback="/placeholder-album.svg"
            alt={artist.name}
            className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[var(--surface-raised)]">
            <User size={36} className="text-[var(--muted)]" aria-hidden="true" />
          </div>
        )}
      </div>
      <div className="mt-3 flex w-full flex-col items-center text-center px-1">
        <span className="w-full truncate text-[14px] font-semibold text-[var(--ink)] group-hover:text-[var(--accent)] transition-colors">
          {artist.name}
        </span>
        <span className="mt-0.5 text-[12px] text-[var(--muted)] truncate">
          {subtitle}
        </span>
      </div>
    </button>
  );
}
