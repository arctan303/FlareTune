import { useCallback, useEffect, useState } from 'react';
import { hydrateSong, hydratePlaylistIndex } from '../utils';
import { usePlayerStore } from '../store/usePlayerStore';
import { useUIStore } from '../store/useUIStore';
import { isValidMusicInitData } from '../musicDataCache';
import { getApiBaseUrl } from '../services/apiBase.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';

const createEmptySongsMap = () => new Map();

export function useMusicData() {
    const [isLoading, setIsLoading] = useState(false);
    const [loadError, setLoadError] = useState(null);
    const [reloadToken, setReloadToken] = useState(0);
    const [myPlaylists, setMyPlaylists] = useState([]);
    const [likedSongs, setLikedSongs] = useState([]);
    const [songsMap, setSongsMap] = useState(createEmptySongsMap);
    const retryMusicData = useCallback(() => setReloadToken((value) => value + 1), []);
    const patchMusicSong = useCallback((songId, patch) => {
        setSongsMap((current) => {
            if (!current.has(songId)) return current;
            const next = new Map(current);
            next.set(songId, { ...next.get(songId), ...patch });
            return next;
        });
        setLikedSongs((current) => current.map((song) => song.id === songId ? { ...song, ...patch } : song));
    }, []);
    const authenticated = useUIStore((state) => Boolean(state.authSession.authenticated));
    const authInitialized = useUIStore((state) => Boolean(state.authSession.initialized));
    const accountId = useUIStore((state) => state.authSession.user?.accountId || null);
    const setAuthSession = useUIStore((state) => state.setAuthSession);

    useEffect(() => {
        if (!authInitialized || !authenticated || !accountId) {
            setMyPlaylists([]);
            setLikedSongs([]);
            setSongsMap(createEmptySongsMap());
            setLoadError(null);
            setIsLoading(false);
            return undefined;
        }

        let cancelled = false;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const fetchAllData = async () => {
            setIsLoading(true);
            setLoadError(null);
            try {
                const response = await authenticatedFetch(`${getApiBaseUrl()}/api/init`, {
                    signal: controller.signal,
                    credentials: 'include',
                    cache: 'no-store',
                });
                if (!response.ok) {
                    const error = new Error(`API /init fetch failed (${response.status})`);
                    error.status = response.status;
                    throw error;
                }

                const json = await response.json();
                if (json.code !== 200 || !isValidMusicInitData(json.data)) {
                    throw new Error('Invalid API response format');
                }

                const defaultListSongs = json.data.default_playlist.songs
                    .map(hydrateSong)
                    .filter((song) => song?.id != null);
                const songsById = new Map(defaultListSongs.map((song) => [song.id, song]));
                const playlists = [
                    hydratePlaylistIndex(json.data.default_playlist),
                    ...json.data.other_playlists.map(hydratePlaylistIndex),
                ].filter(Boolean);

                if (cancelled) return;
                setSongsMap(songsById);
                setMyPlaylists(playlists);
                setLikedSongs(defaultListSongs);

                const playerStore = usePlayerStore.getState();
                if (playerStore.currentSong && songsById.has(playerStore.currentSong.id)) {
                    const refreshedSong = songsById.get(playerStore.currentSong.id);
                    usePlayerStore.setState({
                        currentSong: refreshedSong,
                    });
                }
                if (playerStore.playlist?.length > 0) {
                    const newPlaylist = playerStore.playlist.map((song) => {
                        const refreshedSong = songsById.get(song.id);
                        if (!refreshedSong) return song;
                        return refreshedSong;
                    });
                    usePlayerStore.setState({ playlist: newPlaylist });
                }
            } catch (error) {
                if (cancelled) return;
                if (error?.status === 401) {
                    setAuthSession({ authenticated: false, user: null, initialized: true, error: null });
                    return;
                }
                console.error('加载首页数据失败:', error);
                setLoadError(
                    error?.name === 'AbortError'
                        ? '音乐库连接超时，请检查网络后重试'
                        : error?.status === 429
                                ? '音乐库请求过于频繁，请稍候再试'
                                : '音乐库加载失败，请稍后重试',
                );
            } finally {
                clearTimeout(timeout);
                if (!cancelled) setIsLoading(false);
            }
        };

        void fetchAllData();
        return () => {
            cancelled = true;
            clearTimeout(timeout);
            controller.abort();
        };
    }, [reloadToken, accountId, authenticated, authInitialized, setAuthSession]);

    return {
        myPlaylists,
        likedSongs,
        songsMap,
        isLoading,
        loadError,
        retryMusicData,
        patchMusicSong,
    };
}
