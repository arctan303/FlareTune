import { t } from '../i18n/index.js';
import React from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ArrowUpDown, GripVertical, Loader2, Plus, X } from 'lucide-react';
import PlaylistShelfGrid from './PlaylistShelfGrid.jsx';
import PlaylistCover from './PlaylistCover.jsx';
import PageBackButton from './PageBackButton.jsx';
import { accountPlaylistsStore, useAccountPlaylists } from '../accountPlaylists.js';
import { showToast } from '../store/useUIStore.js';
import { nearestPlaylistSlot } from '../playlistGridDrag.js';

export default function AllPlaylistsView({
    playlists,
    songsMap,
    loadState,
    onOpen,
    onPrefetch,
    onBack,
    onManageShelf,
    isAuthenticated,
    isLeaving = false,
    standalone = false,
}) {
    const memberPlaylists = useAccountPlaylists((state) => state.playlists);
    const regularCount = memberPlaylists.filter((p) => p.kind === 'regular').length;

    const [isCreateOpen, setIsCreateOpen] = React.useState(false);
    const [name, setName] = React.useState('');
    const [description, setDescription] = React.useState('');
    const [isCreating, setIsCreating] = React.useState(false);
    const [errorMsg, setErrorMsg] = React.useState('');
    const nameInputRef = React.useRef(null);

    // 确保当前账号的「我的收藏」歌单必定合并在首位
    const favoriteInAccount = memberPlaylists.find((p) => p.kind === 'favorite');
    const combinedPlaylists = React.useMemo(() => {
        if (!favoriteInAccount) return playlists;
        const exists = playlists.some((p) => String(p.id) === String(favoriteInAccount.id) || p.kind === 'favorite');
        if (exists) return playlists;
        return [{ ...favoriteInAccount, source: 'member' }, ...playlists];
    }, [playlists, favoriteInAccount]);

    // 页面内直接排序编辑模式
    const [isOrdering, setIsOrdering] = React.useState(false);
    const [draftPlaylists, setDraftPlaylists] = React.useState(combinedPlaylists);
    const [isSavingOrder, setIsSavingOrder] = React.useState(false);
    const [activeDragIndex, setActiveDragIndex] = React.useState(null);
    const [floatingDrag, setFloatingDrag] = React.useState(null);
    const dragIndexRef = React.useRef(null);
    const floatingElRef = React.useRef(null);
    const shelfGridRef = React.useRef(null);
    const reorderAnimationsRef = React.useRef(new Map());
    const settleTimerRef = React.useRef(null);

    React.useEffect(() => () => {
        clearTimeout(settleTimerRef.current);
        for (const animation of reorderAnimationsRef.current.values()) animation.cancel();
    }, []);

    React.useEffect(() => {
        if (!isOrdering) {
            setDraftPlaylists(combinedPlaylists);
        }
    }, [combinedPlaylists, isOrdering]);

    React.useEffect(() => {
        if (isCreateOpen) {
            setName('');
            setDescription('');
            setErrorMsg('');
            requestAnimationFrame(() => nameInputRef.current?.focus());
        }
    }, [isCreateOpen]);

    const handleStartOrdering = () => {
        setDraftPlaylists([...combinedPlaylists]);
        setIsOrdering(true);
    };

    const handleCancelOrdering = () => {
        setDraftPlaylists([...combinedPlaylists]);
        setIsOrdering(false);
        setActiveDragIndex(null);
        dragIndexRef.current = null;
        setFloatingDrag(null);
    };

    const handleMoveBy = (fromIndex, offset) => {
        const toIndex = fromIndex + offset;
        if (toIndex < 0 || toIndex >= draftPlaylists.length) return;
        setDraftPlaylists((current) => {
            const next = [...current];
            const [moved] = next.splice(fromIndex, 1);
            next.splice(toIndex, 0, moved);
            return next;
        });
    };

    const handlePointerDownHandle = (index, event, cardEl) => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        const handleEl = event.currentTarget;
        const pointerId = event.pointerId;
        try {
            handleEl.setPointerCapture?.(pointerId);
        } catch {}

        const targetCard = cardEl || handleEl.closest?.('[data-playlist-index]');
        const rect = targetCard?.getBoundingClientRect?.() || handleEl.getBoundingClientRect();
        const grabOffsetX = event.clientX - rect.left;
        const grabOffsetY = event.clientY - rect.top;

        const playlist = draftPlaylists[index];
        if (!playlist) return;

        clearTimeout(settleTimerRef.current);
        flushSync(() => {
            setActiveDragIndex(index);
            setFloatingDrag({
                playlist,
                width: rect.width,
                height: rect.height,
                initialX: rect.left,
                initialY: rect.top,
                grabOffsetX,
                grabOffsetY,
            });
        });
        dragIndexRef.current = index;
        const orderBeforeDrag = [...draftPlaylists];

        const gridCards = () => Array.from(shelfGridRef.current?.children || [])
            .filter((element) => element.hasAttribute('data-playlist-key'));

        const animateReorder = (fromIdx, targetIdx) => {
            const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
            const before = new Map(gridCards().map((card) => [card.dataset.playlistKey, card.getBoundingClientRect()]));
            for (const animation of reorderAnimationsRef.current.values()) animation.cancel();
            reorderAnimationsRef.current.clear();

            flushSync(() => {
                setActiveDragIndex(targetIdx);
                setDraftPlaylists((current) => {
                    const next = [...current];
                    const [moved] = next.splice(fromIdx, 1);
                    next.splice(targetIdx, 0, moved);
                    return next;
                });
            });

            if (reduceMotion) return;
            for (const card of gridCards()) {
                if (Number(card.dataset.playlistIndex) === targetIdx) continue;
                const previous = before.get(card.dataset.playlistKey);
                if (!previous) continue;
                const current = card.getBoundingClientRect();
                const deltaX = previous.left - current.left;
                const deltaY = previous.top - current.top;
                if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
                const animation = card.animate([
                    { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
                    { transform: 'translate3d(0, 0, 0)' },
                ], { duration: 210, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
                reorderAnimationsRef.current.set(card.dataset.playlistKey, animation);
                animation.addEventListener('finish', () => {
                    if (reorderAnimationsRef.current.get(card.dataset.playlistKey) === animation) {
                        reorderAnimationsRef.current.delete(card.dataset.playlistKey);
                    }
                }, { once: true });
            }
        };

        const onPointerMove = (moveEvent) => {
            if (moveEvent.pointerId !== pointerId) return;

            // 1. 1:1 跟随鼠标移动（直接通过 transform 控制，免去每次微移产生 React 重新渲染）
            if (floatingElRef.current) {
                const currentLeft = moveEvent.clientX - grabOffsetX;
                const currentTop = moveEvent.clientY - grabOffsetY;
                floatingElRef.current.style.transform = `translate3d(${currentLeft}px, ${currentTop}px, 0) scale(1.04) rotate(1.2deg)`;
            }

            // 2. 拖拽至窗口上下边缘时平滑自动滚屏
            if (moveEvent.clientY < 70) {
                window.scrollBy({ top: -10, behavior: 'auto' });
            } else if (moveEvent.clientY > window.innerHeight - 70) {
                window.scrollBy({ top: 10, behavior: 'auto' });
            }

            // 网格空隙也属于拖动路径：按二维距离选最近的槽位。
            const grid = shelfGridRef.current;
            if (!grid) return;
            const gridRect = grid.getBoundingClientRect();
            if (moveEvent.clientX < gridRect.left - 40 || moveEvent.clientX > gridRect.right + 40 ||
                moveEvent.clientY < gridRect.top - 40 || moveEvent.clientY > gridRect.bottom + 40) return;
            const slots = gridCards().map((card) => ({
                index: Number(card.dataset.playlistIndex),
                left: gridRect.left + card.offsetLeft,
                right: gridRect.left + card.offsetLeft + card.offsetWidth,
                top: gridRect.top + card.offsetTop,
                bottom: gridRect.top + card.offsetTop + card.offsetHeight,
            }));
            const targetIdx = nearestPlaylistSlot(moveEvent.clientX, moveEvent.clientY, slots);
            if (targetIdx < 0 || targetIdx === dragIndexRef.current) return;
            const fromIdx = dragIndexRef.current;
            dragIndexRef.current = targetIdx;
            animateReorder(fromIdx, targetIdx);
            try { navigator.vibrate?.(10); } catch {}
        };

        const cleanupListeners = () => {
            try {
                handleEl.releasePointerCapture?.(pointerId);
            } catch {}
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
            window.removeEventListener('keydown', onKeyDown);
        };

        const cleanupDrag = () => {
            setActiveDragIndex(null);
            dragIndexRef.current = null;
            setFloatingDrag(null);
        };

        const onPointerUp = (upEvent) => {
            if (upEvent.pointerId !== pointerId) return;
            cleanupListeners();
            if (upEvent.type === 'pointercancel') {
                setDraftPlaylists(orderBeforeDrag);
                cleanupDrag();
                return;
            }
            const destination = gridCards().find((card) => Number(card.dataset.playlistIndex) === dragIndexRef.current);
            if (!destination || !floatingElRef.current) {
                cleanupDrag();
                return;
            }
            if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
                cleanupDrag();
                return;
            }
            const targetRect = destination.getBoundingClientRect();
            floatingElRef.current.style.transition = 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)';
            floatingElRef.current.style.transform = `translate3d(${targetRect.left}px, ${targetRect.top}px, 0)`;
            settleTimerRef.current = setTimeout(cleanupDrag, 180);
        };

        const onKeyDown = (keyEvent) => {
            if (keyEvent.key === 'Escape') {
                cleanupListeners();
                setDraftPlaylists(orderBeforeDrag);
                cleanupDrag();
            }
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        window.addEventListener('keydown', onKeyDown);
    };

    const handleSaveOrder = async () => {
        const shelf = accountPlaylistsStore.getState().shelf;
        if (!shelf || !Number.isInteger(shelf.revision)) {
            showToast(t("唱片架尚未准备就绪，请稍后重试"));
            return;
        }

        setIsSavingOrder(true);
        try {
            const items = draftPlaylists.map((p) => ({ kind: 'member', id: String(p.id) }));
            await accountPlaylistsStore.getState().updateShelfOrder(items, shelf.revision);
            showToast(t("歌单排序已保存"));
            setIsOrdering(false);
        } catch (error) {
            if (error?.status === 409) {
                showToast(t("歌单顺序已在其他位置更新，正在刷新"));
                await accountPlaylistsStore.getState().refreshShelf().catch(() => {});
            } else {
                showToast(error?.message || '保存歌单排序失败');
            }
        } finally {
            setIsSavingOrder(false);
        }
    };

    const handleCreate = async (event) => {
        event?.preventDefault();
        const trimmedName = name.trim();
        if (!trimmedName || Array.from(trimmedName).length > 40) {
            setErrorMsg('歌单名称需为 1 到 40 个字符。');
            return;
        }
        if (Array.from(description.trim()).length > 300) {
            setErrorMsg('歌单简介不能超过 300 个字符。');
            return;
        }
        if (regularCount >= 50) {
            setErrorMsg('已达 50 个歌单上限。');
            return;
        }

        setIsCreating(true);
        setErrorMsg('');
        try {
            const result = await accountPlaylistsStore.getState().createPlaylist({
                name: trimmedName,
                description: description.trim(),
            });
            showToast(t("已创建歌单《{p0}》", { p0: (result.playlist?.name || trimmedName) }));
            setIsCreateOpen(false);
        } catch (error) {
            setErrorMsg(error?.code === 'PLAYLIST_LIMIT_REACHED' ? '已达 50 个歌单上限。' : (error?.message || '创建歌单失败'));
        } finally {
            setIsCreating(false);
        }
    };

    const createSkeletonCard = isAuthenticated ? (
        <button
            type="button"
            key="create-playlist-card"
            onClick={() => setIsCreateOpen(true)}
            className="record-card record-card--create group cursor-pointer text-center"
            aria-label={t("新建个人歌单")}
        >
            <div className="record-card__cover mb-3 flex flex-col items-center justify-center border-2 border-dashed border-[var(--line)] rounded-xl aspect-square w-full transition-all duration-200 group-hover:border-[var(--accent)] group-hover:bg-[var(--surface-raised)]">
                <div className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--surface-raised)] text-[var(--accent-strong)] mb-2 group-hover:scale-110 transition-transform">
                    <Plus size={22} strokeWidth={2.2} />
                </div>
                <span className="text-xs font-semibold text-[var(--ink)]">{t("新建歌单")}</span>
            </div>
            <h4 className="record-card__title truncate text-sm font-semibold text-[var(--ink)] group-hover:text-[var(--accent-strong)]">{t("＋ 新建歌单")}</h4>
            <p className="record-card__meta mt-1 text-xs text-[var(--muted)]">{t("点击快捷创建")}</p>
        </button>
    ) : null;

    const displayPlaylists = isOrdering ? draftPlaylists : combinedPlaylists;

    return (
        <div className={`all-playlists-view ${isLeaving ? 'is-leaving' : ''}`}>
            <header className="all-playlists-header mb-6 sm:mb-8">
                {!standalone && (
                    <PageBackButton onClick={onBack} className="mb-4" />
                )}

                <div className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <p className="collection-section__index">YOUR LIBRARY</p>
                        <h2 className="all-playlists-title text-2xl sm:text-3xl font-semibold tracking-tight">{standalone ? t("资料库") : t("全部歌单")}</h2>
                        <p className="all-playlists-meta text-xs sm:text-sm text-[var(--muted)] mt-1">
                            {isOrdering ? t("按住手柄拖拽或使用箭头调整歌单顺序") : t("共 {p0} 个歌单", { p0: (combinedPlaylists.length) })}
                        </p>
                    </div>

                    {isAuthenticated && (
                        <div className="flex items-center gap-2.5">
                            {isOrdering ? (
                                <>
                                    <button
                                        type="button"
                                        disabled={isSavingOrder}
                                        onClick={handleCancelOrdering}
                                        className="secondary-button px-3.5 py-1.5 text-xs font-medium rounded-xl cursor-pointer"
                                    >{t("取消")}</button>
                                    <button
                                        type="button"
                                        disabled={isSavingOrder}
                                        onClick={handleSaveOrder}
                                        className="primary-button inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-xl cursor-pointer shadow-sm"
                                    >
                                        {isSavingOrder ? <Loader2 size={13} className="animate-spin" /> : null}
                                        <span>{t("完成保存")}</span>
                                    </button>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    onClick={handleStartOrdering}
                                    className="text-button text-button--accent inline-flex items-center gap-1.5 min-h-9 px-3.5 py-1.5 text-xs font-medium rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] hover:bg-[var(--surface)] cursor-pointer transition-all shadow-2xs"
                                    aria-label={t("调整歌单展示顺序")}
                                >
                                    <ArrowUpDown size={14} aria-hidden="true" />
                                    <span>{t("排序编辑")}</span>
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </header>

            <section className="all-playlists-content" aria-label={t("全量歌单列表")}>
                <PlaylistShelfGrid
                    playlists={displayPlaylists}
                    songsMap={songsMap}
                    loadState={loadState}
                    onOpen={isOrdering ? undefined : onOpen}
                    onPrefetch={isOrdering ? undefined : onPrefetch}
                    appendChild={createSkeletonCard}
                    isOrdering={isOrdering}
                    activeDragIndex={activeDragIndex}
                    onPointerDownHandle={handlePointerDownHandle}
                    onMoveBy={handleMoveBy}
                    gridRef={shelfGridRef}
                />
            </section>

            {isCreateOpen && typeof document !== 'undefined' && createPortal(
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="create-playlist-title"
                    className="fixed inset-0 z-[150] flex items-center justify-center p-4"
                    style={{ paddingLeft: 'var(--app-sidebar-width, 0px)' }}
                >
                    <div
                        className="fixed inset-0 bg-black/45 backdrop-blur-sm transition-opacity"
                        onClick={() => !isCreating && setIsCreateOpen(false)}
                    />
                    <div className="playlist-modal-dialog relative z-10 animate-[fade-in_0.2s_ease-out]">
                        <div className="flex items-center justify-between mb-4">
                            <h3 id="create-playlist-title" className="text-lg font-semibold text-[var(--ink)]">{t("新建个人歌单")}</h3>
                            <button
                                type="button"
                                disabled={isCreating}
                                onClick={() => setIsCreateOpen(false)}
                                className="text-[var(--muted)] hover:text-[var(--ink)] p-1 rounded-md cursor-pointer"
                                aria-label={t("关闭对话框")}
                            >
                                <X size={18} />
                            </button>
                        </div>
                        <form onSubmit={handleCreate} className="space-y-4">
                            <div>
                                <label className="block text-xs font-medium text-[var(--muted)] mb-1">{t("歌单名称")}{' '}<span className="text-red-500">*</span></label>
                                <input
                                    ref={nameInputRef}
                                    type="text"
                                    value={name}
                                    maxLength={40}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder={t("输入歌单名称 (1~40字)")}
                                    className="playlist-modal-input"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-[var(--muted)] mb-1">{t("歌单简介")}</label>
                                <textarea
                                    value={description}
                                    maxLength={300}
                                    rows={3}
                                    onChange={(e) => setDescription(e.target.value)}
                                    placeholder={t("输入歌单简介 (选填，最多300字)")}
                                    className="playlist-modal-input resize-none"
                                />
                            </div>
                            {errorMsg && <p className="text-xs text-red-500">{t(errorMsg)}</p>}
                            <div className="flex items-center justify-end gap-3 pt-2">
                                <button
                                    type="button"
                                    disabled={isCreating}
                                    onClick={() => setIsCreateOpen(false)}
                                    className="secondary-button px-4 py-2 text-sm font-medium rounded-xl cursor-pointer"
                                >{t("取消")}</button>
                                <button
                                    type="submit"
                                    disabled={isCreating}
                                    className="primary-button inline-flex items-center gap-1.5 px-5 py-2 text-sm font-semibold rounded-xl cursor-pointer"
                                >
                                    {isCreating ? <Loader2 size={16} className="animate-spin" /> : null}
                                    <span>{t("创建歌单")}</span>
                                </button>
                            </div>
                        </form>
                    </div>
                </div>,
                document.body
            )}

            {floatingDrag && typeof document !== 'undefined' && createPortal(
                <div
                    ref={floatingElRef}
                    className="fixed pointer-events-none z-[9999] select-none will-change-transform"
                    style={{
                        top: 0,
                        left: 0,
                        width: `${floatingDrag.width}px`,
                        height: `${floatingDrag.height}px`,
                        transform: `translate3d(${floatingDrag.initialX}px, ${floatingDrag.initialY}px, 0) scale(1.04) rotate(1.2deg)`,
                        transformOrigin: `${floatingDrag.grabOffsetX}px ${floatingDrag.grabOffsetY}px`,
                    }}
                >
                    <div className="record-card collection-card record-card--editable record-card--floating h-full w-full flex flex-col justify-between">
                        <div className="flex items-center justify-between p-1 mb-2 rounded-lg bg-[var(--surface-raised)] border border-[var(--accent)] text-[var(--accent-strong)] text-xs font-medium shadow-xs">
                            <div className="flex-1 flex items-center justify-center gap-1.5 py-1">
                                <GripVertical size={14} className="shrink-0 text-[var(--accent)]" />
                                <span className="text-[11px] font-semibold">{t("拖拽调整中")}</span>
                            </div>
                        </div>
                        <div className="record-card__cover mb-3 overflow-hidden rounded-xl flex-1 pointer-events-none">
                            <PlaylistCover playlist={floatingDrag.playlist} songsMap={songsMap} />
                        </div>
                        <h3 className="record-card__title truncate text-sm font-semibold">
                            {floatingDrag.playlist?.kind === 'favorite' ? t('我的收藏') : floatingDrag.playlist?.name}
                        </h3>
                        <p className="record-card__meta mt-1 truncate text-xs text-[var(--muted)]">
                            {t("{p0} 首", { p0: (floatingDrag.playlist?.songCount || 0) })}
                        </p>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
