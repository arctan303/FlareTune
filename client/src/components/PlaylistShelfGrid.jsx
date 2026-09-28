import { t } from '../i18n/index.js';
import React from 'react';
import { ChevronLeft, ChevronRight, GripVertical } from 'lucide-react';
import CollectionCard from './catalog/CollectionCard.jsx';
import PlaylistCover from './PlaylistCover.jsx';

export default function PlaylistShelfGrid({
    playlists,
    songsMap,
    loadState,
    onOpen,
    onPrefetch,
    appendChild = null,
    className = '',
    isOrdering = false,
    activeDragIndex = null,
    onPointerDownHandle = null,
    onMoveBy = null,
    gridRef = null,
}) {
    if (playlists.length === 0 && !appendChild) return <div className="theme-empty text-sm py-4">{t("未找到歌单...")}</div>;

    return (
        <div ref={gridRef} className={`record-shelf ${isOrdering ? 'record-shelf--ordering' : ''} ${className}`.trim()}>
            {playlists.map((playlist, index) => {
                const isOpening = loadState?.playlist?.id === playlist.id && loadState?.status === 'opening';
                const isDragging = activeDragIndex === index;

                if (isOrdering) {
                    const isFavorite = playlist.kind === 'favorite';
                    const title = isFavorite ? t('我的收藏') : playlist.name;
                    const meta = t("{p0} 首", { p0: (playlist.songCount || 0) });

                    return (
                        <div
                            key={`member:${playlist.id}`}
                            data-playlist-index={index}
                            data-playlist-key={`member:${playlist.id}`}
                            className={`record-card collection-card record-card--editable relative group select-none ${
                                isDragging ? 'is-dragging-placeholder' : 'hover:border-[var(--line-strong)]'
                            }`}
                        >
                            {/* 顶部手柄控制条：移动端与桌面端通用手柄 + 微调前后箭头 */}
                            <div className="flex items-center justify-between p-1 mb-2 rounded-lg bg-[var(--surface-raised)] border border-[var(--line)] shadow-xs">
                                <button
                                    type="button"
                                    disabled={index === 0}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onMoveBy?.(index, -1);
                                    }}
                                    className="p-1 rounded text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface)] disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer transition-colors"
                                    title={t("前移一位")}
                                    aria-label={t("将 {p0} 前移一位", { p0: (title) })}
                                >
                                    <ChevronLeft size={16} />
                                </button>

                                <div
                                    className="playlist-drag-handle flex-1 flex items-center justify-center gap-1.5 py-1 px-2 cursor-grab active:cursor-grabbing text-xs text-[var(--muted)] hover:text-[var(--ink)] font-medium select-none rounded hover:bg-[var(--surface)] transition-colors"
                                    style={{ touchAction: 'none' }}
                                    onPointerDown={(e) => onPointerDownHandle?.(index, e, e.currentTarget.closest('[data-playlist-index]'))}
                                    title={t("按住手柄拖动调整顺序")}
                                >
                                    <GripVertical size={14} className="shrink-0 text-[var(--muted)]" />
                                    <span className="text-[11px] font-mono opacity-80">#{index + 1}</span>
                                    <span className="text-[11px] font-medium">{t("拖动")}</span>
                                </div>

                                <button
                                    type="button"
                                    disabled={index === playlists.length - 1}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onMoveBy?.(index, 1);
                                    }}
                                    className="p-1 rounded text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface)] disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer transition-colors"
                                    title={t("后移一位")}
                                    aria-label={t("将 {p0} 后移一位", { p0: (title) })}
                                >
                                    <ChevronRight size={16} />
                                </button>
                            </div>

                            {/* 卡片封面与信息（编辑态禁用点击打开） */}
                            <div className="record-card__cover mb-3 overflow-hidden rounded-xl pointer-events-none">
                                <PlaylistCover playlist={playlist} songsMap={songsMap} />
                            </div>
                            <h3 className="record-card__title truncate text-sm font-semibold">{title}</h3>
                            <p className="record-card__meta mt-1 truncate text-xs text-[var(--muted)]">{meta}</p>
                        </div>
                    );
                }

                return (
                    <CollectionCard
                        key={`member:${playlist.id}`}
                        kind="playlist"
                        item={playlist}
                        songsMap={songsMap}
                        onOpen={onOpen}
                        onPrefetch={onPrefetch}
                        isOpening={isOpening}
                    />
                );
            })}
            {!isOrdering && appendChild}
        </div>
    );
}
