import React from 'react';
import { ChevronDown, ChevronUp, Save, Search, Trash2 } from 'lucide-react';
import { resolveCoverUrl } from '../utils.js';
import LazyImage from './LazyImage.jsx';

export default function AdminPlaylistSongsModal({
  playlist,
  songs,
  searchText,
  searchResults,
  onSearchChange,
  onAddSong,
  onMoveSong,
  onRemoveSong,
  onSave,
  onClose,
}) {
  if (!playlist) return null;

  return (
    <div className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-[var(--surface)] rounded-3xl shadow-2xl border border-[var(--line)] p-6 sm:p-8 flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between pb-3 border-b border-[var(--line)] mb-4">
          <div>
            <h3 className="text-base font-bold text-[var(--ink)]">曲目编排 - {playlist.name}</h3>
            <span className="text-xs text-[var(--muted)]">共 {songs.length} 首歌曲</span>
          </div>
          <button type="button" onClick={onClose} className="text-[var(--muted)] hover:text-[var(--ink)]">✕</button>
        </div>

        <div className="mb-3">
          <div className="relative">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
            <input
              type="text"
              placeholder="从曲库搜索歌曲并添加进此歌单..."
              value={searchText}
              onChange={(event) => onSearchChange(event.target.value)}
              className="w-full pl-9 pr-4 py-2 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] text-xs text-[var(--ink)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </div>
        </div>

        {searchResults.length > 0 && (
          <div className="mb-4 max-h-40 overflow-y-auto border border-[var(--line)] rounded-2xl divide-y divide-[var(--line)] bg-[var(--surface-raised)]">
            {searchResults.map((song) => {
              const alreadyIn = songs.some((item) => item.id === song.id);
              return (
                <div key={song.id} className="flex items-center justify-between p-2.5 text-xs">
                  <span className="truncate pr-2 font-medium text-[var(--ink)]">{song.title} - {song.artist}</span>
                  <button
                    type="button"
                    disabled={alreadyIn}
                    onClick={() => onAddSong(song)}
                    className="px-3 py-1 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-strong)] disabled:opacity-40 text-white text-[11px] font-semibold transition"
                  >
                    {alreadyIn ? '已包含' : '+ 添加'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex-1 overflow-y-auto border border-[var(--line)] rounded-2xl divide-y divide-[var(--line)] bg-[var(--surface)]">
          {songs.length === 0 ? (
            <div className="py-12 text-center text-xs text-[var(--muted)]">当前歌单暂无歌曲</div>
          ) : songs.map((song, index) => (
            <div key={song.id} className="flex items-center justify-between p-3 hover:bg-[var(--surface-raised)] transition">
              <div className="flex items-center gap-3 min-w-0 pr-2">
                <span className="w-6 text-center text-xs font-mono text-[var(--faint)]">{index + 1}</span>
                <div className="w-9 h-9 rounded-lg bg-[var(--surface-raised)] overflow-hidden flex-shrink-0">
                  <LazyImage src={resolveCoverUrl(song.cover_url)} alt={song.title} className="w-full h-full object-cover" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-[var(--ink)] truncate">{song.title}</p>
                  <p className="text-[11px] text-[var(--muted)] truncate">{song.artist}</p>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button type="button" disabled={index === 0} onClick={() => onMoveSong(index, -1)} className="p-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-raised)] disabled:opacity-20 transition" title="上移">
                  <ChevronUp size={15} />
                </button>
                <button type="button" disabled={index === songs.length - 1} onClick={() => onMoveSong(index, 1)} className="p-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-raised)] disabled:opacity-20 transition" title="下移">
                  <ChevronDown size={15} />
                </button>
                <button type="button" onClick={() => onRemoveSong(song.id)} className="p-1.5 text-[var(--muted)] hover:text-rose-500 hover:bg-rose-500/10 rounded-lg ml-1 transition" title="移除">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-[var(--line)] mt-4">
          <span className="text-xs text-[var(--muted)]">调整曲序后请点击「保存曲序」</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl border border-[var(--line)] text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)]">关闭</button>
            <button type="button" onClick={onSave} className="px-5 py-2 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-xs font-semibold flex items-center gap-1.5 shadow-xs">
              <Save size={13} />
              <span>保存曲序</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
