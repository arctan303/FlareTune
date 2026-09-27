import React from 'react';
import { ChevronLeft, ChevronRight, Edit2, Play, Trash2, Volume2 } from 'lucide-react';
import { formatDuration, hydrateSong, resolveCoverUrl } from '../utils.js';
import { getLanguageShortLabel } from '../constants/language.js';
import LazyImage from './LazyImage.jsx';

export default function AdminSongsTable({
  songs,
  loading,
  total,
  page,
  limit,
  keyword,
  filter,
  currentSong,
  isPlaying,
  onPlay,
  onPageChange,
  onEdit,
  onDelete,
}) {
  const pageCount = Math.ceil(total / limit);
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] overflow-hidden shadow-xs">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead><tr className="border-b border-[var(--line)] bg-[var(--surface-raised)] text-[var(--muted)] font-semibold"><th className="py-3.5 pl-6 pr-4 w-12 text-center">#</th><th className="py-3.5 px-4">歌曲</th><th className="py-3.5 px-4">歌手</th><th className="py-3.5 px-4">专辑</th><th className="py-3.5 px-4 text-center">时长</th><th className="py-3.5 px-4 text-center">语言</th><th className="py-3.5 pr-6 pl-4 text-right">管理操作</th></tr></thead>
          <tbody className="divide-y divide-[var(--line)]">
            {loading ? <tr><td colSpan={7} className="py-16 text-center text-xs text-[var(--muted)]">加载中...</td></tr> : songs.length === 0 ? <tr><td colSpan={7} className="py-16 text-center text-xs text-[var(--muted)]">未找到符合条件的歌曲</td></tr> : songs.map((song, index) => {
              const isCurrent = currentSong?.id === song.id;
              return (
                <tr key={song.id} className={`hover:bg-[var(--surface-raised)] transition group ${isCurrent ? 'bg-[var(--surface-raised)]' : ''}`}>
                  <td className="py-3 pl-6 pr-4 text-center text-[var(--faint)] font-mono text-[11px]">{(page - 1) * limit + index + 1}</td>
                  <td className="py-3 px-4 min-w-[200px]"><div className="flex items-center gap-3"><div className="relative w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-[var(--surface-raised)] group/cover cursor-pointer"><LazyImage src={resolveCoverUrl(song.cover_url)} alt={song.title} className="w-full h-full object-cover" /><button type="button" onClick={() => onPlay(hydrateSong(song), songs.map(hydrateSong))} className="absolute inset-0 bg-black/40 text-white flex items-center justify-center opacity-0 group-hover/cover:opacity-100 transition" title="播放">{isCurrent && isPlaying ? <Volume2 size={16} /> : <Play size={16} />}</button></div><div className="min-w-0"><div className="flex items-center gap-2"><span className={`font-semibold text-xs truncate ${isCurrent ? 'text-[var(--accent-strong)]' : 'text-[var(--ink)]'}`}>{song.title}</span></div><span className="text-[10px] text-[var(--faint)] font-mono truncate block">{song.id}</span></div></div></td>
                  <td className="py-3 px-4 text-[var(--muted)] font-medium max-w-[140px] truncate">{song.artist || '未知歌手'}</td>
                  <td className="py-3 px-4 text-[var(--muted)] max-w-[140px] truncate">{song.album || '-'}</td>
                  <td className="py-3 px-4 text-center text-[var(--muted)] font-mono">{formatDuration(song.duration)}</td>
                  <td className="py-3 px-4 text-center"><div className="inline-flex items-center gap-1.5 flex-wrap justify-center">{song.language ? <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/20" title={`语言：${song.language}`}>{getLanguageShortLabel(song.language)}</span> : <span className="px-1.5 py-0.5 rounded-md text-[10px] font-normal bg-zinc-500/10 text-zinc-400" title="未打标语言，可播放时在音乐工具中直接设置">未打标</span>}</div></td>
                  <td className="py-3 pr-6 pl-4 text-right"><div className="inline-flex items-center gap-1"><button type="button" onClick={() => onEdit(song)} title="编辑元数据" className="p-1.5 text-[var(--muted)] hover:text-[var(--accent-strong)] hover:bg-[var(--surface-raised)] rounded-lg transition"><Edit2 size={15} /></button><button type="button" onClick={() => onDelete(song)} title="删除歌曲" className="p-1.5 text-[var(--muted)] hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition"><Trash2 size={15} /></button></div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {total > limit && <div className="flex items-center justify-between px-6 py-4 border-t border-[var(--line)] bg-[var(--surface-raised)]"><span className="text-xs text-[var(--muted)]">第 {page} 页，共 {pageCount} 页 (总计 {total} 首歌曲)</span><div className="flex items-center gap-2"><button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1, keyword, filter)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink)] disabled:opacity-30 transition hover:bg-[var(--surface-raised)]"><ChevronLeft size={14} /> 上一页</button><button type="button" disabled={page >= pageCount} onClick={() => onPageChange(page + 1, keyword, filter)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink)] disabled:opacity-30 transition hover:bg-[var(--surface-raised)]">下一页 <ChevronRight size={14} /></button></div></div>}
    </div>
  );
}
