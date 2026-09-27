import React from 'react';
import { ALL_LANGUAGES } from '../constants/language.js';

export function AdminSongEditModal({ song, form, playlists, onChange, onSubmit, onClose }) {
  if (!song) return null;
  return (
    <div className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-[var(--surface)] rounded-3xl shadow-2xl border border-[var(--line)] p-6 sm:p-8">
        <h3 className="text-lg font-bold text-[var(--ink)] mb-4">编辑单曲元数据</h3>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[var(--muted)] mb-1">歌曲 ID (只读)</label>
            <input type="text" value={song.id} disabled className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--surface-raised)] border border-[var(--line)] text-xs font-mono text-[var(--muted)]" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[var(--muted)] mb-1">歌曲标题</label>
            <input type="text" required value={form.title} onChange={(event) => onChange('title', event.target.value)} className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--surface-raised)] border border-[var(--line)] text-xs text-[var(--ink)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-[var(--muted)] mb-1">歌手</label>
              <input type="text" value={form.artist} onChange={(event) => onChange('artist', event.target.value)} className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--surface-raised)] border border-[var(--line)] text-xs text-[var(--ink)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[var(--muted)] mb-1">专辑</label>
              <input type="text" value={form.album} onChange={(event) => onChange('album', event.target.value)} className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--surface-raised)] border border-[var(--line)] text-xs text-[var(--ink)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-[var(--muted)] mb-1">歌曲语言</label>
            <select required value={form.language || ''} onChange={(event) => onChange('language', event.target.value)} className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--surface-raised)] border border-[var(--line)] text-xs text-[var(--ink)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]">
              <option value="" disabled>请选择歌曲语言</option>
              {ALL_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
            </select>
          </div>
          {playlists.length > 0 && (
            <div className="pt-2">
              <label className="block text-xs font-semibold text-[var(--muted)] mb-1.5">历史歌单引用</label>
              <div className="flex flex-wrap gap-2">
                {playlists.map((playlist) => <span key={playlist.id} className="px-2.5 py-1 rounded-lg text-xs bg-[var(--surface-raised)] border border-[var(--line)] text-[var(--ink)]">{playlist.name}</span>)}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-6 border-t border-[var(--line)]">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl border border-[var(--line)] text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)] transition">取消</button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-xs font-semibold transition shadow-xs">保存更新</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function AdminSongDeleteModal({ song, preview, mode, onModeChange, onConfirm, onClose }) {
  if (!song) return null;
  return (
    <div className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-[var(--surface)] rounded-3xl shadow-2xl border border-[var(--line)] p-6 sm:p-8">
        <h3 className="text-lg font-bold text-rose-600 dark:text-rose-400 mb-2">确认删除歌曲</h3>
        <p className="text-xs text-[var(--muted)] mb-4">你正在删除「<strong className="text-[var(--ink)]">{song.title}</strong> - {song.artist}」。</p>
        {preview && (
          <div className="p-4 rounded-2xl bg-[var(--surface-raised)] border border-[var(--line)] text-xs text-[var(--muted)] space-y-1.5 mb-4">
            <div>历史歌单引用: {preview.relations?.length || 0} 个</div>
            <div>关联翻译缓存: {preview.translations_count || 0} 条</div>
          </div>
        )}
        <div className="space-y-2 mb-6">
          <label className="flex items-center gap-2 text-xs text-[var(--ink)] cursor-pointer">
            <input type="radio" name="delMode" value="retain" checked={mode === 'retain'} onChange={() => onModeChange('retain')} className="text-[var(--accent)]" />
            <span>移出曲库，保留 R2 媒体文件（推荐）</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 cursor-pointer">
            <input type="radio" name="delMode" value="permanent" checked={mode === 'permanent'} onChange={() => onModeChange('permanent')} className="text-rose-600" />
            <span>永久清理曲库及关联 R2 媒体</span>
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl border border-[var(--line)] text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)] transition">取消</button>
          <button type="button" onClick={onConfirm} className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition shadow-xs">确认删除</button>
        </div>
      </div>
    </div>
  );
}
