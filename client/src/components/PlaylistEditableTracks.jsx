import { localizeUnknownArtist, t } from '../i18n/index.js';
import React from 'react';
import { ChevronDown, ChevronUp, GripVertical, Trash2 } from 'lucide-react';
import LazyImage from './LazyImage.jsx';

const getRowStyle = (index, dragState) => {
    if (!dragState) return {};
    if (index === dragState.startIndex) {
        return dragState.settling
            ? {
                transform: `translate3d(${dragState.offsetX}px, ${dragState.offsetY}px, 0)`,
                transition: 'transform 190ms cubic-bezier(0.2, 0, 0, 1), box-shadow 190ms ease, background-color 190ms ease',
                zIndex: 50,
                position: 'relative',
            }
            : {
                transform: `translate3d(${dragState.offsetX}px, ${dragState.offsetY}px, 0) scale(1.02)`,
                transition: 'none',
                zIndex: 50,
                position: 'relative',
            };
    }

    let targetSlot = index;
    if (dragState.startIndex < dragState.targetIndex && index > dragState.startIndex && index <= dragState.targetIndex) {
        targetSlot = index - 1;
    } else if (dragState.startIndex > dragState.targetIndex && index >= dragState.targetIndex && index < dragState.startIndex) {
        targetSlot = index + 1;
    }

    if (targetSlot === index) {
        return {
            transform: 'translate3d(0, 0, 0)',
            transition: 'transform 200ms cubic-bezier(0.2, 0, 0, 1)',
        };
    }

    const currentColumn = index % dragState.gridColumns;
    const currentRow = Math.floor(index / dragState.gridColumns);
    const targetColumn = targetSlot % dragState.gridColumns;
    const targetRow = Math.floor(targetSlot / dragState.gridColumns);
    return {
        transform: `translate3d(${(targetColumn - currentColumn) * dragState.colStride}px, ${(targetRow - currentRow) * dragState.rowStride}px, 0)`,
        transition: 'transform 200ms cubic-bezier(0.2, 0, 0, 1)',
    };
};

export default function PlaylistEditableTracks({
    songs,
    dragState,
    onBeginDrag,
    onMoveDrag,
    onFinishDrag,
    onMoveSong,
    onRemoveSong,
}) {
    if (songs.length === 0) {
        return (
            <div className="state-panel p-8 text-center border border-dashed border-[var(--line)] rounded-2xl">
                <p className="text-sm text-[var(--muted)]">{onRemoveSong ? t("已移出所有歌曲。点击「保存」将清空歌单，或点击「取消」恢复原状。") : t("暂无歌曲可排序。")}</p>
            </div>
        );
    }

    return songs.map((song, index) => {
        const isDragging = index === dragState?.startIndex;
        return (
            <div
                key={song.id}
                data-song-drag-row="true"
                data-song-id={String(song.id)}
                style={getRowStyle(index, dragState)}
                onPointerDown={(event) => {
                    if (event.target.closest('button, a, input, textarea')) return;
                    if (event.pointerType === 'mouse') onBeginDrag(song.id, index, event);
                }}
                className={`track-row group relative flex items-center gap-3 sm:gap-4 select-none ${isDragging ? 'is-drag-active' : ''}`}
            >
                <button
                    type="button"
                    onPointerDown={(event) => {
                        event.stopPropagation();
                        onBeginDrag(song.id, index, event);
                    }}
                    onPointerMove={onMoveDrag}
                    onPointerUp={(event) => onFinishDrag(event)}
                    onPointerCancel={(event) => onFinishDrag(event, true)}
                    className="account-order-handle p-1.5 cursor-grab active:cursor-grabbing text-[var(--muted)] hover:text-[var(--ink)] flex-shrink-0 touch-none select-none rounded-lg hover:bg-[var(--surface-raised)] transition-colors"
                    title={t("按住拖拽调整排序")}
                    aria-label={t("按住拖拽调整 {p0} 排序", { p0: (song.title) })}
                >
                    <GripVertical size={18} />
                </button>

                <span className="track-row__number shrink-0 font-mono text-xs text-[var(--faint)]" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                </span>
                <div className="track-row__cover relative h-[52px] w-[52px] flex-shrink-0 overflow-hidden rounded-lg">
                    <LazyImage
                        src={song.cover_url || '/placeholder-album.svg'}
                        alt={song.title ? t("{p0} - {p1} 专辑封面", { p0: song.title, p1: localizeUnknownArtist(song.artist) }) : t("专辑封面")}
                        className="h-full w-full object-cover"
                    />
                </div>
                <div className="flex-1 min-w-0">
                    <h4 className="track-row__title truncate text-sm font-semibold text-[var(--ink)]">{song.title}</h4>
                    <div className="track-row__meta flex items-center truncate text-xs text-[var(--muted)] mt-0.5">
                        <span className="truncate max-w-[50%]">{song.artist}</span>
                        {song.album && (
                            <>
                                <span className="mx-1.5 opacity-40 text-[9px]">•</span>
                                <span className="track-row__album truncate">{song.album}</span>
                            </>
                        )}
                    </div>
                </div>
                <div className="track-row__actions flex items-center justify-end gap-1">
                    <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => onMoveSong(index, index - 1)}
                        className="track-row__action disabled:opacity-20 disabled:pointer-events-none"
                        title={t("上移")}
                        aria-label={t("上移 {p0}", { p0: (song.title) })}
                    >
                        <ChevronUp size={18} />
                    </button>
                    <button
                        type="button"
                        disabled={index === songs.length - 1}
                        onClick={() => onMoveSong(index, index + 1)}
                        className="track-row__action disabled:opacity-20 disabled:pointer-events-none"
                        title={t("下移")}
                        aria-label={t("下移 {p0}", { p0: (song.title) })}
                    >
                        <ChevronDown size={18} />
                    </button>
                    {onRemoveSong && <button
                        type="button"
                        onClick={() => onRemoveSong(song.id)}
                        className="track-row__action text-[var(--danger)] hover:opacity-80"
                        title={t("从歌单移除")}
                        aria-label={t("从歌单移除 {p0}", { p0: (song.title) })}
                    >
                        <Trash2 size={18} />
                    </button>}
                </div>
            </div>
        );
    });
}
