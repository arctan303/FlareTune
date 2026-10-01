import { t } from '../i18n/index.js';
import React, { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { showToast, useUIStore } from '../store/useUIStore';
import { accountPlaylistsStore, isAccountPlaylistStaleError, useAccountPlaylists } from '../accountPlaylists';
import { isTopmostModal, trapDrawerTabKey } from './drawers/drawerFocus.js';

export default function AddToPlaylistModal() {
    const isOpen = useUIStore((s) => s.isAddToPlaylistOpen);
    const songs = useUIStore((s) => s.addToPlaylistSongs);
    const closeAddToPlaylist = useUIStore((s) => s.closeAddToPlaylist);
    const isAuthenticated = useUIStore((s) => Boolean(s.authSession.authenticated));

    const [mounted, setMounted] = useState(false);
    const [isClosing, setIsClosing] = useState(false);
    const modalRef = React.useRef(null);

    const accountPlaylists = useAccountPlaylists((state) => state.playlists);
    const accountDetails = useAccountPlaylists((state) => state.details);
    const accountShelf = useAccountPlaylists((state) => state.shelf);

    const [selectedTargetIds, setSelectedTargetIds] = useState([]);
    const [isLoading, setIsLoading] = useState(false);

    const songIds = React.useMemo(() => songs.map((s) => String(s?.id || s)), [songs]);

    const favorite = accountPlaylists.find((playlist) => playlist.kind === 'favorite') || null;
    const playlistTargets = React.useMemo(() => {
        const byId = new Map(accountPlaylists.map((playlist) => [playlist.id, playlist]));
        const ordered = favorite ? [favorite] : [];
        for (const item of accountShelf?.items || []) {
            if (item.kind !== 'member') continue;
            const playlist = byId.get(item.id);
            if (playlist?.kind === 'regular') ordered.push(playlist);
        }
        const included = new Set(ordered.map((playlist) => playlist.id));
        ordered.push(...accountPlaylists.filter((playlist) => playlist.kind === 'regular' && !included.has(playlist.id)));
        return ordered;
    }, [accountPlaylists, accountShelf, favorite]);

    useEffect(() => {
        if (isOpen && isAuthenticated) {
            setMounted(true);
            setIsClosing(false);
        } else if (mounted) {
            setIsClosing(true);
            const timer = setTimeout(() => {
                setMounted(false);
                setIsClosing(false);
                setSelectedTargetIds([]);
            }, 220);
            return () => clearTimeout(timer);
        }
        return undefined;
    }, [isOpen, isAuthenticated, mounted]);

    useEffect(() => {
        if (!isOpen || !mounted || isClosing) return undefined;

        const handleModalTabKey = (event) => {
            const modal = modalRef.current;
            if (!isTopmostModal(modal, document)) return;
            trapDrawerTabKey(event, modal, document.activeElement);
        };
        document.addEventListener('keydown', handleModalTabKey, true);

        const state = accountPlaylistsStore.getState();
        const missing = accountPlaylists.filter((playlist) => !state.details[playlist.id]);
        if (missing.length > 0) {
            setIsLoading(true);
            Promise.all(missing.map((playlist) => accountPlaylistsStore.getState().loadDetail(playlist.id)))
                .catch((error) => {
                    if (!isAccountPlaylistStaleError(error)) {
                        showToast(t("歌单内容加载失败，请重试"));
                    }
                })
                .finally(() => setIsLoading(false));
        }

        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                closeAddToPlaylist();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleModalTabKey, true);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen, mounted, isClosing, accountPlaylists, closeAddToPlaylist]);

    if (!mounted || !isAuthenticated) return null;

    const toggleTarget = (playlistId) => {
        setSelectedTargetIds((current) => current.includes(playlistId)
            ? current.filter((id) => id !== playlistId)
            : [...current, playlistId]);
    };

    const handleConfirm = async () => {
        if (songIds.length === 0 || selectedTargetIds.length === 0) return;
        if (songIds.length * selectedTargetIds.length > 500) {
            showToast(t("一次加入的歌曲与歌单组合不能超过 500"));
            return;
        }
        const state = accountPlaylistsStore.getState();
        const targets = selectedTargetIds.flatMap((playlistId) => {
            const detail = state.details[playlistId];
            return detail ? [{ playlistId, expectedRevision: detail.revision }] : [];
        });
        if (targets.length !== selectedTargetIds.length) {
            showToast(t("部分歌单内容尚未加载，请重试"));
            return;
        }
        setIsLoading(true);
        try {
            const data = await accountPlaylistsStore.getState().addSongs(targets, songIds);
            if (data.outcome === 'partial') showToast(t("部分歌单已更新，冲突或达到上限的目标未修改"));
            else if (data.refreshFailed) showToast(t("歌曲已加入，列表刷新失败"));
            else if (data.outcome === 'noop') showToast(t("所选歌曲已在目标歌单中"));
            else showToast(songIds.length === 1 && songs[0]?.title
                ? `已将《${songs[0].title}》加入 ${selectedTargetIds.length} 个歌单`
                : `已将 ${songIds.length} 首歌曲加入 ${selectedTargetIds.length} 个歌单`);
            closeAddToPlaylist();
        } catch (error) {
            if (isAccountPlaylistStaleError(error)) return;
            showToast(error?.status === 409 ? '歌单已更新，请重试' : '加入歌单失败');
        } finally {
            setIsLoading(false);
        }
    };

    const firstSongTitle = songs[0]?.title;

    return (
        <div ref={modalRef} className={`search-playlist-picker-sheet ${isClosing ? 'is-closing' : ''}`} role="dialog" aria-modal="true" aria-hidden={isClosing || !isOpen}>
            <div className="search-playlist-picker-sheet__backdrop" onClick={closeAddToPlaylist} />
            <section className="search-playlist-picker" aria-label={t("选择目标歌单")}>
                <div className="search-playlist-picker__heading">
                    <div>
                        <strong>{t("加入歌单")}</strong>
                        <small>{songIds.length === 1 && firstSongTitle ? `《${firstSongTitle}》` : t("已选择 {p0} 首", { p0: (songIds.length) })}</small>
                    </div>
                    <button type="button" onClick={closeAddToPlaylist} aria-label={t("关闭加入歌单选择器")}>
                        <X size={16} />
                    </button>
                </div>
                {isLoading && playlistTargets.some((playlist) => !accountDetails[playlist.id]) ? (
                    <div className="search-playlist-picker__loading">
                        <Loader2 size={14} className="animate-spin" />{t("正在读取歌单")}</div>
                ) : (
                    <div className="search-playlist-picker__targets">
                        {playlistTargets.map((playlist) => {
                            const detail = accountDetails[playlist.id];
                            const includedCount = detail?.songs?.filter((item) => songIds.includes(String(item.id))).length || 0;
                            const missingCount = songIds.length - includedCount;
                            const overLimit = Boolean(detail && detail.songs.length + missingCount > 500);
                            return (
                                <label key={playlist.id} className={overLimit ? 'is-disabled' : ''}>
                                    <input
                                        type="checkbox"
                                        checked={selectedTargetIds.includes(playlist.id)}
                                        disabled={!detail || overLimit}
                                        onChange={() => toggleTarget(playlist.id)}
                                    />
                                    <span>
                                        <strong>{playlist.kind === 'favorite' ? t("我的收藏") : playlist.name}</strong>
                                        <small>
                                            {playlist.songCount || 0}{t("首歌曲")}{includedCount > 0 ? ` · ${includedCount === songIds.length ? t("均已收录") : t("已收录 {p0} 首", { p0: (includedCount) })}` : ''}
                                        </small>
                                    </span>
                                    {overLimit && <em>{t("超过 500 首上限")}</em>}
                                </label>
                            );
                        })}
                        {playlistTargets.length === 0 && <p className="theme-empty py-3 text-center text-xs">{t("暂无可用歌单")}</p>}
                    </div>
                )}
                <button
                    type="button"
                    className="primary-button search-playlist-picker__submit"
                    disabled={isLoading || songIds.length === 0 || selectedTargetIds.length === 0}
                    onClick={handleConfirm}
                >
                    {isLoading ? t("正在加入...") : t("确定加入{p0}", { p0: (selectedTargetIds.length > 0 ? ` (${selectedTargetIds.length})` : '') })}
                </button>
            </section>
        </div>
    );
}
