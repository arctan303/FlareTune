import React from 'react';
import { FolderPlus, ListPlus, Pencil, Star, Trash2 } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore.js';
import FloatingTrackMenu from './FloatingTrackMenu.jsx';

export default function SongActionsMenu({ song, anchorRef, onClose, isLiked, isLikePending = false,
  onToggleLiked, onInsertNext, onAddToPlaylist, onRemove, removeLabel = '移除', autoFocusFirstItem = true }) {
  const isAdmin = useUIStore((state) => state.authSession?.user?.role === 'admin');
  const openQuickSongEdit = useUIStore((state) => state.openQuickSongEdit);

  const dismiss = React.useCallback(() => {
    onClose?.();
    anchorRef.current?.focus();
  }, [anchorRef, onClose]);

  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismiss]);

  const run = (action) => (event) => {
    event.stopPropagation();
    dismiss();
    action?.(song, event);
  };

  const toggleLiked = (event) => {
    event.stopPropagation();
    if (isLikePending) return;
    dismiss();
    onToggleLiked?.(song, event);
  };

  return <FloatingTrackMenu anchorRef={anchorRef} onDismiss={dismiss}
    label={`${song.title} 的歌曲选项`} autoFocusFirstItem={autoFocusFirstItem}
    onClick={(event) => event.stopPropagation()}>
    {onToggleLiked && <button type="button" role="menuitem" className={`track-row__menu-item ${isLiked ? 'text-[var(--danger)]' : ''}`}
      disabled={isLikePending} onClick={toggleLiked}>
      <Star size={18} fill={isLiked ? 'currentColor' : 'none'} aria-hidden="true" />
      <span>{isLiked ? '移出我的收藏' : '加入我的收藏'}</span>
    </button>}
    {onInsertNext && <button type="button" role="menuitem" className="track-row__menu-item" onClick={run(onInsertNext)}>
      <ListPlus size={16} aria-hidden="true" /><span>插播到下一首</span>
    </button>}
    {onAddToPlaylist && <button type="button" role="menuitem" className="track-row__menu-item" onClick={run(onAddToPlaylist)}>
      <FolderPlus size={16} aria-hidden="true" /><span>加入歌单</span>
    </button>}
    {isAdmin && <button type="button" role="menuitem" className="track-row__menu-item" onClick={(event) => {
      event.stopPropagation();
      onClose?.();
      openQuickSongEdit(song.id, anchorRef.current);
    }}>
      <Pencil size={16} aria-hidden="true" /><span>编辑歌曲信息</span>
    </button>}
    {onRemove && <button type="button" role="menuitem" className="track-row__menu-item text-[var(--danger)]" onClick={run(onRemove)}>
      <Trash2 size={16} aria-hidden="true" /><span>{removeLabel}</span>
    </button>}
  </FloatingTrackMenu>;
}
