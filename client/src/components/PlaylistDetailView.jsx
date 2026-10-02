import { t } from '../i18n/index.js';
import React from 'react';
import {
    ChevronRight,
    Disc3,
    Loader2,
    MessageCircle,
    Pencil,
    PlayCircle,
    RefreshCw,
    Save,
    Trash2,
    X,
} from 'lucide-react';
import usePlaylistEditor from '../hooks/usePlaylistEditor.js';
import LazyImage from './LazyImage';
import PlaylistEditableTracks from './PlaylistEditableTracks.jsx';
import PageBackButton from './PageBackButton.jsx';
import PlaylistCover from './PlaylistCover';
import {
    cleanPlaylistDescription,
    PendingPlaylistDetail,
    PlaylistDescriptionDrawer,
} from './PlaylistDetailSupport.jsx';
import TrackRow from './TrackRow';
import UserImageEditor from './UserImageEditor.jsx';
import { accountPlaylistsStore } from '../accountPlaylists.js';

export default function PlaylistDetailView({
    isViewingPlaylist,
    loadState,
    leaving,
    playlist,
    playlistInfo,
    playlistSongs,
    invalidSongCount,
    ambientCoverUrl,
    songsMap,
    currentSong,
    isPlaying,
    isPersonalPlaylist,
    showFavoriteAction,
    headingRef,
    onClose,
    onRetry,
    onPlaySong,
    onToggleLiked,
    isSongLiked,
    onInsertNext,
    onAddToPlaylist,
    onOpenAssistant,
    onLoadMoreLibrarySongs,
    onChangeLibrarySort,
    onRefreshDailyRecommend,
    isRefreshingDailyRecommend,
}) {
    const isDailyRecommend = playlist?.id === 'daily-recommend';
    const isLibraryCategory = playlist?.type === 'library';
    const pagination = playlist?.pagination;
    const currentSort = pagination?.sort || playlist?.sort || 'desc';
    const [isLoadingMore, setIsLoadingMore] = React.useState(false);
    const [isSorting, setIsSorting] = React.useState(false);

    const handleLoadMore = async () => {
        if (!onLoadMoreLibrarySongs || isLoadingMore) return;
        setIsLoadingMore(true);
        try {
            await onLoadMoreLibrarySongs();
        } finally {
            setIsLoadingMore(false);
        }
    };

    const handleSortChange = async (sort) => {
        if (!onChangeLibrarySort || isSorting || sort === currentSort) return;
        setIsSorting(true);
        try {
            await onChangeLibrarySort(sort);
        } finally {
            setIsSorting(false);
        }
    };

    const [isDescriptionOpen, setIsDescriptionOpen] = React.useState(false);
    const {
        isEditing,
        draftName,
        setDraftName,
        draftDescription,
        setDraftDescription,
        draftSongs,
        isSaving,
        errorMsg,
        dragState,
        handleStartEdit,
        handleCancelEdit,
        handleSaveAll,
        handleDeletePlaylist,
        moveSong,
        removeSongFromDraft,
        beginPointerDrag,
        movePointerDrag,
        finishPointerDrag,
    } = usePlaylistEditor({ playlist, playlistInfo, playlistSongs, onClose });
    return (
        <>
            {!isViewingPlaylist && <PendingPlaylistDetail loadState={loadState} onClose={onClose} onRetry={onRetry} headingRef={headingRef} />}
            {isViewingPlaylist && (
                <div className={`playlist-detail w-full ${leaving ? 'playlist-detail-leave' : 'playlist-detail-enter'}`}>
                    <div className="mb-10">
                        <PageBackButton onClick={onClose} className="mb-6" />
                        {ambientCoverUrl && (
                            <div
                                className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-5xl h-[360px] md:h-[420px] pointer-events-none overflow-hidden -z-10 blur-3xl opacity-35 dark:opacity-25 transition-opacity duration-1000 select-none"
                                style={{
                                    maskImage: 'radial-gradient(ellipse 80% 70% at 50% 35%, rgba(0,0,0,1) 20%, transparent 80%)',
                                    WebkitMaskImage: 'radial-gradient(ellipse 80% 70% at 50% 35%, rgba(0,0,0,1) 20%, transparent 80%)',
                                }}
                                aria-hidden="true"
                            >
                                <LazyImage src={ambientCoverUrl} fallback="/placeholder-album.svg" className="h-full w-full object-cover object-center scale-125 saturate-150" alt={t("歌单背景氛围图")} />
                            </div>
                        )}
                        <div className="playlist-masthead relative mb-10 flex flex-col items-center gap-6 md:flex-row md:items-stretch md:gap-8">
                            <div className="group w-[184px] flex-shrink-0 md:w-60">
                                <div className="playlist-masthead__cover relative overflow-hidden rounded-xl">
                                    <PlaylistCover playlist={playlist} songsMap={songsMap} />
                                    {isPersonalPlaylist && playlist.source === 'member' && playlist.kind === 'regular' && isEditing && (
                                        <UserImageEditor
                                            variant="overlay"
                                            purpose="playlist"
                                            targetId={playlist.id}
                                            slot={{ url: playlist.customCoverUrl, revision: playlist.coverRevision ?? 0 }}
                                            onSaved={slot => accountPlaylistsStore.setState(state => ({
                                                playlists: state.playlists.map(p => p.id === playlist.id ? { ...p, customCoverUrl: slot.url, coverRevision: slot.revision } : p),
                                                details: { ...state.details, ...(state.details[playlist.id] ? { [playlist.id]: { ...state.details[playlist.id], customCoverUrl: slot.url, coverRevision: slot.revision } } : {}) },
                                            }))}
                                        />
                                    )}
                                </div>
                            </div>
                            <div className="playlist-masthead__copy flex min-w-0 flex-1 flex-col justify-end self-stretch space-y-3 md:space-y-4">
                                <div className="space-y-1.5">
                                    <p className="playlist-eyebrow text-xs md:text-sm">
                                        {playlist.kind === 'favorite' ? t("私人精选") : t("歌单")}
                                    </p>

                                    {isEditing && playlist.kind !== 'favorite' ? (
                                        <div>
                                            <input
                                                type="text"
                                                value={draftName}
                                                onChange={(e) => setDraftName(e.target.value)}
                                                maxLength={40}
                                                placeholder={t("输入歌单名称 (1~40字)")}
                                                className="playlist-edit-title-input"
                                                aria-label={t("歌单名称")}
                                            />
                                            {errorMsg && <p className="text-xs text-red-500 font-medium mt-1">{t(errorMsg)}</p>}
                                        </div>
                                    ) : (
                                        <h3 ref={headingRef} tabIndex={-1} className="playlist-title mb-4 line-clamp-2 outline-none md:mb-6">{playlist.kind === 'favorite' ? t("我的收藏") : playlist.name}</h3>
                                    )}

                                    {isEditing && playlist.kind !== 'favorite' ? (
                                        <div className="pt-1 max-w-3xl">
                                            <textarea
                                                value={draftDescription}
                                                onChange={(e) => setDraftDescription(e.target.value)}
                                                maxLength={300}
                                                rows={2}
                                                placeholder={t("点击添加歌单简介 (选填，最多300字)...")}
                                                className="playlist-edit-desc-input"
                                                aria-label={t("歌单简介")}
                                            />
                                        </div>
                                    ) : (
                                        playlist.kind !== 'favorite' && playlistInfo?.description && (
                                            <div className="pt-0.5 max-w-3xl">
                                                <p onClick={() => setIsDescriptionOpen(true)} className="playlist-description line-clamp-2 text-xs md:text-sm font-medium text-gray-900 dark:text-gray-100 leading-relaxed cursor-pointer hover:opacity-80 transition-opacity mb-1 drop-shadow-[0_1px_2px_rgba(255,255,255,0.8)] dark:drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" title={t("点击查看完整歌单简介")}>
                                                    {cleanPlaylistDescription(playlistInfo.description)}
                                                </p>
                                                {(playlistInfo.description.length > 40 || playlistInfo.description.includes('\n')) && (
                                                    <button type="button" onClick={() => setIsDescriptionOpen(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-[color:var(--accent-strong)] hover:opacity-75 dark:text-[color:var(--accent-strong)] transition-opacity cursor-pointer">{t("查看完整简介")}<ChevronRight size={13} />
                                                    </button>
                                                )}
                                            </div>
                                        )
                                    )}
                                </div>

                                <div className="playlist-meta flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-[color:var(--muted)]">
                                    {playlistInfo?.createdAt && <span className="flex items-center gap-1">{playlistInfo.createdAt}</span>}
                                    <span className="flex items-center gap-1">
                                        {playlistInfo?.createdAt && <span className="mx-1 opacity-50 text-[10px]">•</span>}
                                        {isEditing ? (
                                            <span>{t("当前")}{draftSongs.length}{t("首歌")}{playlist.kind !== 'favorite' && draftSongs.length !== playlistSongs.length && (
                                                    <span className="text-red-500 ml-1">{t("(已移出")}{playlistSongs.length - draftSongs.length}{t("首)")}</span>
                                                )}
                                            </span>
                                        ) : (
                                            t("{p0} 首歌", { p0: (playlistSongs.length + invalidSongCount) })
                                        )}
                                    </span>
                                </div>

                                {/* ── 操作按钮区域 (Action Bar) ── */}
                                <div className="playlist-actions flex flex-wrap items-center gap-3 pt-0.5 sm:pt-1">
                                        {isEditing ? (
                                            <>
                                                {/* 按钮 1：取消 */}
                                                <button
                                                    type="button"
                                                    onClick={handleCancelEdit}
                                                    disabled={isSaving}
                                                    className="playlist-action-play secondary-button"
                                                    aria-label={t("取消编辑")}
                                                >
                                                    <X size={16} aria-hidden="true" />
                                                    <span>{t("取消")}</span>
                                                </button>
                                                {/* 按钮 2：保存 */}
                                                <button
                                                    type="button"
                                                    onClick={handleSaveAll}
                                                    disabled={isSaving}
                                                    className="playlist-action-play primary-button"
                                                    aria-label={playlist.kind === 'favorite' ? t("保存收藏歌曲排序") : t("保存歌单修改")}
                                                >
                                                    {isSaving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
                                                    <span>{t("保存")}</span>
                                                </button>
                                                {/* 按钮 3：删除歌单（仅自建常规歌单） */}
                                                {playlist.kind === 'regular' && (
                                                    <button
                                                        type="button"
                                                        onClick={handleDeletePlaylist}
                                                        disabled={isSaving}
                                                        className="playlist-action-play text-red-500 hover:text-red-600 border border-red-200 dark:border-red-900/40 bg-[var(--surface)] hover:bg-red-50 dark:hover:bg-red-950/30"
                                                        title={t("删除歌单")}
                                                        aria-label={t("删除歌单")}
                                                    >
                                                        <Trash2 size={16} aria-hidden="true" />
                                                        <span>{t("删除歌单")}</span>
                                                    </button>
                                                )}
                                            </>
                                        ) : (
                                            <>
                                                {playlistSongs.length > 0 && (
                                                    <button type="button" onClick={() => onPlaySong(playlistSongs[0], playlistSongs)} className="playlist-action-play primary-button" aria-label={t("播放全部歌曲")}>
                                                        <PlayCircle size={18} aria-hidden="true" /><span>{t("播放全部")}</span>
                                                    </button>
                                                )}
                                                {isDailyRecommend && onRefreshDailyRecommend && (
                                                    <button
                                                        type="button"
                                                        onClick={onRefreshDailyRecommend}
                                                        disabled={isRefreshingDailyRecommend}
                                                        className="playlist-action-play secondary-button"
                                                        aria-label={t("刷新今日推荐歌曲")}
                                                        title={t("刷新今日推荐歌曲")}
                                                    >
                                                        {isRefreshingDailyRecommend ? (
                                                            <Loader2 size={16} className="animate-spin text-[var(--accent)]" aria-hidden="true" />
                                                        ) : (
                                                            <RefreshCw size={16} aria-hidden="true" />
                                                        )}
                                                        <span>{isRefreshingDailyRecommend ? t("刷新中…") : t("刷新")}</span>
                                                    </button>
                                                )}
                                                {isPersonalPlaylist && (
                                                    <button
                                                        type="button"
                                                        onClick={handleStartEdit}
                                                        className="playlist-action-play secondary-button"
                                                        title={playlist.kind === 'favorite' ? t("调整歌曲顺序") : t("编辑歌单")}
                                                        aria-label={playlist.kind === 'favorite' ? t("调整歌曲顺序") : t("编辑歌单")}
                                                    >
                                                        <Pencil size={16} aria-hidden="true" />
                                                        <span>{playlist.kind === 'favorite' ? t("调整顺序") : t("编辑歌单")}</span>
                                                    </button>
                                                )}
                                                {isLibraryCategory && (
                                                    <div className="inline-flex items-center p-0.5 rounded-xl bg-[var(--surface-raised)] border border-[var(--line)] text-xs font-medium">
                                                        <button
                                                            type="button"
                                                            onClick={() => handleSortChange('desc')}
                                                            disabled={isSorting || currentSort === 'desc'}
                                                            className={`px-3 py-1.5 rounded-lg transition-all ${
                                                                currentSort === 'desc'
                                                                    ? 'bg-[var(--surface)] text-[var(--ink)] shadow-xs font-bold'
                                                                    : 'text-[var(--muted)] hover:text-[var(--ink)]'
                                                            }`}
                                                        >{t("最新收录")}</button>
                                                        <button
                                                            type="button"
                                                            onClick={() => handleSortChange('asc')}
                                                            disabled={isSorting || currentSort === 'asc'}
                                                            className={`px-3 py-1.5 rounded-lg transition-all ${
                                                                currentSort === 'asc'
                                                                    ? 'bg-[var(--surface)] text-[var(--ink)] shadow-xs font-bold'
                                                                    : 'text-[var(--muted)] hover:text-[var(--ink)]'
                                                            }`}
                                                        >{t("最早收录")}</button>
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>

                        {/* ── 歌曲列表展示 ── */}
                        {isEditing ? (
                            <div className="track-list track-list--detail mt-6 relative">
                                <PlaylistEditableTracks
                                    songs={draftSongs}
                                    dragState={dragState}
                                    onBeginDrag={beginPointerDrag}
                                    onMoveDrag={movePointerDrag}
                                    onFinishDrag={finishPointerDrag}
                                    onMoveSong={moveSong}
                                    onRemoveSong={playlist.kind === 'favorite' ? null : removeSongFromDraft}
                                />
                            </div>
                        ) : playlistSongs.length > 0 ? (
                            <>
                                <div className={`track-list track-list--detail mt-6 transition-opacity duration-300 ${
                                    isRefreshingDailyRecommend ? 'opacity-40 pointer-events-none' : 'opacity-100'
                                }`}>
                                    {playlistSongs.map((song, index) => (
                                        <TrackRow
                                            key={song.id}
                                            song={song}
                                            songs={playlistSongs}
                                            index={index}
                                            variant="detail"
                                            currentSong={currentSong}
                                            isPlaying={isPlaying}
                                            playSong={onPlaySong}
                                            isLiked={isSongLiked(song)}
                                            onToggleLiked={showFavoriteAction ? onToggleLiked : null}
                                            onInsertNext={onInsertNext}
                                            onAddToPlaylist={onAddToPlaylist}
                                            onRemove={null}
                                        />
                                    ))}
                                </div>
                                {isLibraryCategory && (
                                    <div className="py-8 flex flex-col items-center justify-center gap-2">
                                        {pagination?.hasMore ? (
                                            <button
                                                type="button"
                                                onClick={handleLoadMore}
                                                disabled={isLoadingMore}
                                                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full text-xs font-semibold border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-raised)] hover:border-[var(--line-strong)] text-[var(--ink)] transition-all cursor-pointer shadow-xs disabled:opacity-60"
                                            >
                                                {isLoadingMore ? (
                                                    <>
                                                        <Loader2 size={14} className="animate-spin text-[var(--accent)]" />
                                                        <span>{t("加载中...")}</span>
                                                    </>
                                                ) : (
                                                        <span>{t("加载更多")}</span>
                                                )}
                                            </button>
                                        ) : (
                                            null
                                        )}
                                    </div>
                                )}
                            </>
                        ) : isPersonalPlaylist ? (
                            <section className="local-playlist-empty mt-6" aria-labelledby="playlist-empty-title">
                                <span className="local-playlist-empty__mark" aria-hidden="true"><Disc3 size={24} /></span>
                                <div className="local-playlist-empty__copy">
                                    <p className="state-panel__eyebrow">ACCOUNT PLAYLIST</p>
                                    <h4 id="playlist-empty-title">{t("账号歌单还是空的")}</h4>
                                    <p>{invalidSongCount > 0 ? t("{p0} 首歌曲暂时无法播放。", { p0: (invalidSongCount) }) : t("歌单暂无歌曲")}</p>
                                </div>
                                <button type="button" className="primary-button local-playlist-empty__action inline-flex min-h-11 items-center gap-2 px-4 text-sm font-semibold" onClick={onOpenAssistant}>
                                    <MessageCircle size={16} aria-hidden="true" />{t("前往助手挑歌")}</button>
                            </section>
                        ) : (
                            <section className="state-panel mt-6 p-8 text-center" aria-labelledby="playlist-empty-title">
                                <p className="state-panel__eyebrow">PLAYLIST EMPTY</p>
                                <h4 id="playlist-empty-title" className="text-xl">{t("这个歌单还没有可播放的歌曲")}</h4>
                                <p className="state-panel__copy mt-3">{invalidSongCount > 0 ? t("{p0} 首歌曲缺少可播放资源，歌单仍可编辑。", { p0: (invalidSongCount) }) : t("歌单暂时没有内容。")}</p>
                            </section>
                        )}
                    </div>
                </div>
            )}
            <PlaylistDescriptionDrawer playlist={playlist} info={playlistInfo} isOpen={isDescriptionOpen} onClose={() => setIsDescriptionOpen(false)} />
        </>
    );
}
