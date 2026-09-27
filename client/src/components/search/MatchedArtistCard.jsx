import React, { useEffect, useState } from 'react';
import { User } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { authenticatedFetch } from '../../services/authenticatedFetch';
import {
  getArtistPhotoApiBase,
  ARTIST_PHOTO_CACHE,
  preloadAndDecodeImage,
} from '../../hooks/useArtistPhotos';
import { HighlightText } from './HighlightText.jsx';

export function MatchedArtistCard({ artist, query, onOpenArtist }) {
  const [photoUrl, setPhotoUrl] = useState(null);

  useEffect(() => {
    if (!artist?.name) return;
    const trimmed = artist.name.trim();
    if (ARTIST_PHOTO_CACHE.has(trimmed)) {
      const cached = ARTIST_PHOTO_CACHE.get(trimmed);
      if (Array.isArray(cached) && cached.length > 0 && cached[0]?.url) {
        setPhotoUrl(cached[0].url);
        return;
      }
    }
    let cancelled = false;
    const apiBase = getArtistPhotoApiBase();
    authenticatedFetch(`${apiBase}/api/artist-photo?name=${encodeURIComponent(trimmed)}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const photos = data?.data?.photos || [];
        ARTIST_PHOTO_CACHE.set(trimmed, photos);
        if (photos.length > 0 && photos[0]?.url) {
          setPhotoUrl(photos[0].url);
          preloadAndDecodeImage(photos[0].url);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [artist?.name]);

  const displayAvatar = photoUrl || artist.coverUrl;

  return (
    <button
      type="button"
      onClick={() => {
        onOpenArtist?.({
          type: 'artist',
          name: artist.name,
          coverUrl: displayAvatar,
        });
        useUIStore.getState().openArtistDrawer({
          name: artist.name,
          songs: artist.songs,
          coverUrl: displayAvatar,
        });
      }}
      className="search-artist-circle-card group flex flex-col items-center p-3 rounded-2xl bg-[var(--surface-raised)]/40 hover:bg-[var(--surface-raised)] border border-[var(--line)] hover:border-[var(--line-strong)] hover:shadow-xs transition-all cursor-pointer select-none text-center"
      title={`进入 ${artist.name} 歌手专区`}
      aria-label={`进入 ${artist.name} 歌手专区`}
    >
      {/* 圆形写真头像 */}
      <div className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-full overflow-hidden bg-neutral-900 border-2 border-[var(--line-strong)] group-hover:border-[var(--accent)] shadow-sm shrink-0 flex items-center justify-center transition-all group-hover:scale-105">
        {displayAvatar ? (
          <img
            src={displayAvatar}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <User size={32} className="text-[var(--muted)]" />
        )}
      </div>

      {/* 歌手信息：姓名与艺人标签 */}
      <div className="min-w-0 w-full mt-2.5">
        <h4 className="text-xs sm:text-sm font-bold text-[var(--ink)] truncate group-hover:text-[var(--accent)] transition-colors">
          <HighlightText text={artist.name} query={query} />
        </h4>
        <p className="text-[11px] text-[var(--muted)] truncate mt-0.5">
          艺人
        </p>
      </div>
    </button>
  );
}
