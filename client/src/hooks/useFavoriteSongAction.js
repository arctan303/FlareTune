import React from 'react';
import {
  accountPlaylistsStore,
  isAccountPlaylistStaleError,
  useAccountPlaylists,
} from '../accountPlaylists.js';
import { showToast } from '../store/useUIStore.js';

const pendingFavoriteSongIds = new Set();

export function getFavoriteActionSuccessMessage(song, { isRemoving, outcome, refreshFailed } = {}) {
  const title = song?.title || '歌曲';
  if (isRemoving) return `已从我的收藏移除《${title}》`;
  if (refreshFailed) return `已加入《${title}》，列表刷新失败`;
  if (outcome === 'noop') return `《${title}》已在我的收藏中`;
  return `已将《${title}》加入我的收藏`;
}

export function useFavoriteSongAction() {
  const playlists = useAccountPlaylists((state) => state.playlists);
  const details = useAccountPlaylists((state) => state.details);
  const favoritePlaylist = playlists.find((playlist) => playlist.kind === 'favorite') || null;
  const favoriteDetail = favoritePlaylist ? details[favoritePlaylist.id] : null;
  const favoriteSongIdsKey = (favoriteDetail?.songs || []).map((song) => String(song.id)).join('\u0000');
  const favoriteSongIds = React.useMemo(
    () => new Set((favoriteDetail?.songs || []).map((song) => String(song.id))),
    [favoriteSongIdsKey],
  );
  const [pendingSongIds, setPendingSongIds] = React.useState(new Set());
  const [justAddedSongIds, setJustAddedSongIds] = React.useState(new Set());

  const isFavorite = React.useCallback(
    (songOrId) => favoriteSongIds.has(String(songOrId?.id ?? songOrId)),
    [favoriteSongIds],
  );

  const toggleFavorite = React.useCallback(async (song, event) => {
    event?.stopPropagation();
    if (!song?.id) {
      showToast('当前未选择歌曲');
      return false;
    }
    if (!favoritePlaylist || !favoriteDetail) {
      showToast('我的收藏尚未加载，请重试');
      return false;
    }

    const id = String(song.id);
    if (pendingFavoriteSongIds.has(id)) return false;
    pendingFavoriteSongIds.add(id);
    setPendingSongIds((current) => new Set(current).add(id));
    const isRemoving = favoriteSongIds.has(id);

    try {
      if (isRemoving) {
        await accountPlaylistsStore.getState().removeSong(favoritePlaylist.id, id, favoriteDetail.revision);
        showToast(getFavoriteActionSuccessMessage(song, { isRemoving: true }));
      } else {
        const data = await accountPlaylistsStore.getState().addSongs(
          [{ playlistId: favoritePlaylist.id, expectedRevision: favoriteDetail.revision }],
          [id],
        );
        showToast(getFavoriteActionSuccessMessage(song, data));
        if (data.outcome !== 'noop') {
          setJustAddedSongIds((current) => new Set(current).add(id));
        }
      }
      return true;
    } catch (error) {
      if (!isAccountPlaylistStaleError(error)) {
        showToast(error?.status === 409 ? '歌单已更新，请重试' : '我的收藏更新失败');
      }
      return false;
    } finally {
      pendingFavoriteSongIds.delete(id);
      setPendingSongIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, [favoriteDetail, favoritePlaylist, favoriteSongIds]);

  const clearAddedAnimation = React.useCallback((songOrId) => {
    const id = String(songOrId?.id ?? songOrId);
    setJustAddedSongIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  return {
    favoritePlaylist,
    favoriteDetail,
    favoriteSongIds,
    pendingSongIds,
    justAddedSongIds,
    isFavorite,
    toggleFavorite,
    clearAddedAnimation,
  };
}
