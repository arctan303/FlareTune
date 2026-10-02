import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { useUIStore } from '../store/useUIStore.js';
import { stopSessionPlayback } from '../utils/playerSessionCleanup.js';
import { usePrivateMediaSource } from './usePrivateMediaSource.js';
import { imageLoadRegistry } from '../utils/imageLoadRegistry.js';
import { localizeUnknownArtist, t, useLocale } from '../i18n/index.js';

export function selectMediaSessionArtwork(coverUrl, resolvedCoverUrl, registry = imageLoadRegistry) {
    if (!registry.isPrivateMediaUrl(coverUrl)) return coverUrl || '/favicon.png';
    return resolvedCoverUrl?.startsWith('blob:') && registry.getReadySource(coverUrl) === resolvedCoverUrl
        ? resolvedCoverUrl : '/favicon.png';
}

export function useMediaSession({ currentSong, isPlaying }) {
    // A restored paused queue is not a playback action in this new session.
    const hasPlayedInSession = useRef(false);
    useEffect(() => {
        const unsubscribe = useUIStore.subscribe((next, previous) => {
            const before = previous.authSession?.authenticated ? previous.authSession.user?.accountId : null;
            const after = next.authSession?.authenticated ? next.authSession.user?.accountId : null;
            if (before && before !== after) {
                hasPlayedInSession.current = false;
                stopSessionPlayback(usePlayerStore);
            }
        });
        return () => { unsubscribe(); hasPlayedInSession.current = false; stopSessionPlayback(usePlayerStore); };
    }, []);
    const locale = useLocale();
    const coverUrl = currentSong?.cover_url || '';
    const resolvedCoverUrl = usePrivateMediaSource(coverUrl);
    useEffect(() => {
        if (!('mediaSession' in navigator)) return;
        if (isPlaying) hasPlayedInSession.current = true;

        if (currentSong && hasPlayedInSession.current) {
            try {
                const cover = selectMediaSessionArtwork(coverUrl, resolvedCoverUrl);
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: currentSong.title || t('未知歌曲'),
                    artist: localizeUnknownArtist(currentSong.artist),
                    album: currentSong.album || '',
                    artwork: [
                        { src: cover, sizes: '96x96', type: 'image/png' },
                        { src: cover, sizes: '128x128', type: 'image/png' },
                        { src: cover, sizes: '192x192', type: 'image/png' },
                        { src: cover, sizes: '256x256', type: 'image/png' },
                        { src: cover, sizes: '384x384', type: 'image/png' },
                        { src: cover, sizes: '512x512', type: 'image/png' },
                    ]
                });
            } catch (err) {
                console.error("MediaSession metadata error:", err);
            }
        } else {
            navigator.mediaSession.metadata = null;
        }
    }, [currentSong?.id, currentSong?.title, currentSong?.artist, currentSong?.album, coverUrl, resolvedCoverUrl, locale, isPlaying]);

    useEffect(() => {
        if (!('mediaSession' in navigator)) return;

        navigator.mediaSession.playbackState = currentSong && hasPlayedInSession.current
            ? (isPlaying ? 'playing' : 'paused')
            : 'none';
    }, [isPlaying, currentSong]);

    useEffect(() => {
        if (!('mediaSession' in navigator)) return;

        if (!hasPlayedInSession.current) return;
        const setHandler = (action, handler) => {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch (e) {
                // 部分旧浏览器可能不支持特定 action
            }
        };

        setHandler('play', () => {
            const state = usePlayerStore.getState();
            if (!state.isPlaying) state.togglePlay();
        });
        setHandler('pause', () => {
            const state = usePlayerStore.getState();
            if (state.isPlaying) state.togglePlay();
        });
        setHandler('previoustrack', () => usePlayerStore.getState().playPrev());
        setHandler('nexttrack', () => usePlayerStore.getState().playNext());

        setHandler('seekto', (details) => {
            const audio = usePlayerStore.getState().audioRef?.current;
            if (audio && details.seekTime !== undefined) {
                audio.currentTime = details.seekTime;
                usePlayerStore.getState().setProgress(details.seekTime);
            }
        });

        setHandler('seekforward', (details) => {
            const audio = usePlayerStore.getState().audioRef?.current;
            if (audio) {
                const offset = details.seekOffset || 10;
                const target = Math.min(audio.duration || Infinity, audio.currentTime + offset);
                audio.currentTime = target;
                usePlayerStore.getState().setProgress(target);
            }
        });

        setHandler('seekbackward', (details) => {
            const audio = usePlayerStore.getState().audioRef?.current;
            if (audio) {
                const offset = details.seekOffset || 10;
                const target = Math.max(0, audio.currentTime - offset);
                audio.currentTime = target;
                usePlayerStore.getState().setProgress(target);
            }
        });

        setHandler('stop', () => {
            const audio = usePlayerStore.getState().audioRef?.current;
            if (audio) {
                audio.pause();
                audio.currentTime = 0;
            }
            usePlayerStore.getState().setIsPlaying(false);
            usePlayerStore.getState().setProgress(0);
        });

        return () => {
            const actions = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekforward', 'seekbackward', 'stop'];
            actions.forEach((action) => setHandler(action, null));
        };
    }, [isPlaying]);
}
