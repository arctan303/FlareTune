import React from 'react';
import { Disc, Play } from 'lucide-react';
import { HighlightText } from './HighlightText.jsx';
import { resolveSongLanguage } from '../../utils/songType.js';
import { getLanguageShortLabel } from '../../constants/language.js';

export function TopResultCard({ song, query, onPlay }) {
  const language = resolveSongLanguage(song);
  const langLabel = getLanguageShortLabel(language);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onPlay?.(song)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay?.(song);
        }
      }}
      className="search-top-result-card group relative flex items-center gap-3.5 p-3 rounded-2xl bg-[var(--surface-raised)] border border-[var(--line)] hover:border-[var(--line-strong)] hover:shadow-xs transition-all cursor-pointer select-none text-left"
      title={`播放 ${song.title} - ${song.artist}`}
    >
      <div className="relative w-12 h-12 rounded-xl overflow-hidden bg-neutral-900 border border-[var(--line-strong)] shrink-0 flex items-center justify-center">
        {song.cover_url ? (
          <img
            src={song.cover_url}
            alt=""
            className="w-full h-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <Disc size={20} className="text-[var(--muted)]" />
        )}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-white">
          <Play size={18} fill="currentColor" className="ml-0.5" />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-bold text-[var(--ink)] truncate group-hover:text-[var(--accent)] transition-colors">
          <HighlightText text={song.title} query={query} />
        </h4>
        <p className="text-xs text-[var(--muted)] truncate mt-0.5 flex items-center gap-1.5">
          <span className="truncate">
            歌曲 · <HighlightText text={song.artist || '未知歌手'} query={query} />
          </span>
          {langLabel && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--line)] text-[var(--muted)] shrink-0">
              {langLabel}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
