import React from 'react';
import { getApiBaseUrl } from '../services/apiBase.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';
import { useUIStore } from '../store/useUIStore.js';
import { isPageVisible, usePageVisibility } from './usePageVisibility.js';
import { createArtistImagePreloader, ExpiringLruMap } from '../utils/artistPhotoResources.js';

export const ARTIST_PHOTO_ROTATE_INTERVAL = 16000; // 16 秒平滑轮播下一张写真
export const ARTIST_PHOTO_CACHE = new ExpiringLruMap({ maxEntries: 64, ttlMs: 30 * 60 * 1000 });
export const ARTIST_PHOTO_IMAGE_CACHE = new ExpiringLruMap({ maxEntries: 128, ttlMs: 5 * 60 * 1000 });
export const ARTIST_PHOTO_PLAYBACK_PROGRESS = new ExpiringLruMap({ maxEntries: 64, ttlMs: 24 * 60 * 60 * 1000 });

export const getArtistPhotoApiBase = () => getApiBaseUrl();

// 全站写真请求共享两路加载/解码，布尔缓存仅表示近期成功，不持有位图。
export const preloadAndDecodeImage = createArtistImagePreloader(ARTIST_PHOTO_IMAGE_CACHE);

/**
 * 歌手写真加载与轮播 Hook：
 * 管理写真预加载、预解码、轮播定时器、双层景深推拉转场栈 (Zoom In/Out + Blur Dissolve) 与跨生命周期进度记忆。
 */
export function useArtistPhotos({
    artistName = '',
    enabled = true,
    isPlaying = true,
    isBuffering = false,
    suspendEffects = false,
    prefersReducedMotion = false,
}) {
    const pageVisible = usePageVisibility();
    const authenticated = useUIStore((state) => Boolean(state.authSession?.authenticated));
    const canLoadPhotos = enabled && authenticated;
    const [artistPhotos, setArtistPhotos] = React.useState([]);
    const [photoIndex, setPhotoIndex] = React.useState(0);
    const [photoLayers, setPhotoLayers] = React.useState([]);
    const [isPhotoLoading, setIsPhotoLoading] = React.useState(false);
    const [readyArtist, setReadyArtist] = React.useState('');
    const rotationTimerRef = React.useRef(null);
    const crossFadeTimerRef = React.useRef(null);
    const fadeOutRafRef = React.useRef(null);
    const layerIdRef = React.useRef(0);
    const photoIndexRef = React.useRef(0);
    const requestGenerationRef = React.useRef(0);
    const shownPhotoRef = React.useRef(null);

    const clearPhotoTransition = React.useCallback(() => {
        if (crossFadeTimerRef.current) clearTimeout(crossFadeTimerRef.current);
        if (fadeOutRafRef.current) cancelAnimationFrame(fadeOutRafRef.current);
        crossFadeTimerRef.current = null;
        fadeOutRafRef.current = null;
    }, []);

    React.useEffect(() => clearPhotoTransition, [clearPhotoTransition]);

    // 保持 photoIndexRef 同步
    React.useEffect(() => {
        photoIndexRef.current = photoIndex;
    }, [photoIndex]);

    const showPhoto = React.useCallback((url, index = 0) => {
        if (!url) return;
        if (shownPhotoRef.current?.url === url && shownPhotoRef.current.reduced === prefersReducedMotion) return;
        shownPhotoRef.current = { url, reduced: prefersReducedMotion };
        clearPhotoTransition();
        const id = ++layerIdRef.current;

        if (prefersReducedMotion) {
            setPhotoLayers([{
                id,
                url,
                opacity: 1,
                transform: 'scale(1) translate3d(0, 0, 0)',
                filter: 'blur(0px)',
                index,
            }]);
            return;
        }

        const isEven = index % 2 === 0;
        const initialTransform = isEven
            ? 'scale(1.08) translate3d(0, 1.2%, 0)'
            : 'scale(0.94) translate3d(0, -1.2%, 0)';
        const exitTransform = isEven
            ? 'scale(0.95) translate3d(0, -1%, 0)'
            : 'scale(1.05) translate3d(0, 1%, 0)';

        setPhotoLayers((prev) => {
            const top = prev[prev.length - 1];
            return [
                ...prev.slice(0, Math.max(0, prev.length - 1)),
                ...(top ? [{
                    ...top,
                    opacity: 0,
                    transform: exitTransform,
                    filter: 'blur(6px)',
                }] : []),
                {
                    id,
                    url,
                    opacity: 0,
                    transform: initialTransform,
                    filter: 'blur(10px)',
                    index,
                },
            ];
        });

        const reveal = () => {
            setPhotoLayers((prev) => prev.map((layer) => (
                layer.id === id
                    ? {
                        ...layer,
                        opacity: 1,
                        transform: 'scale(1) translate3d(0, 0, 0)',
                        filter: 'blur(0px)',
                    }
                    : layer
            )));
        };
        fadeOutRafRef.current = requestAnimationFrame(() => {
            fadeOutRafRef.current = requestAnimationFrame(() => {
                fadeOutRafRef.current = null;
                reveal();
            });
        });

        if (crossFadeTimerRef.current) clearTimeout(crossFadeTimerRef.current);
        crossFadeTimerRef.current = setTimeout(() => {
            crossFadeTimerRef.current = null;
            setPhotoLayers((prev) => prev.filter((layer) => layer.id === id));
        }, 1600);
    }, [clearPhotoTransition, prefersReducedMotion]);

    const preloadNextPhoto = React.useCallback((photos, index, isCurrent) => {
        if (!isCurrent() || photos.length <= 1) return;
        void preloadAndDecodeImage(photos[(index + 1) % photos.length]?.url, { isCurrent, priority: 'prefetch' });
    }, []);

    const applyInitialPhoto = React.useCallback(async (photos, initialIndex, isCurrent, artist) => {
        if (!isCurrent()) return;
        if (!photos || photos.length === 0) {
            clearPhotoTransition();
            shownPhotoRef.current = null;
            setPhotoLayers([]);
            return;
        }
        const idx = (initialIndex >= 0 && initialIndex < photos.length) ? initialIndex : 0;
        // 只加载当前候选；坏图依次跳过，成功后再准备下一张。
        for (let offset = 0; offset < photos.length; offset++) {
            const nextIdx = (idx + offset) % photos.length;
            const ready = await preloadAndDecodeImage(photos[nextIdx]?.url, { isCurrent });
            if (!isCurrent()) return;
            if (ready) {
                photoIndexRef.current = nextIdx;
                setPhotoIndex(nextIdx);
                setReadyArtist(artist);
                ARTIST_PHOTO_PLAYBACK_PROGRESS.set(artist, nextIdx);
                showPhoto(photos[nextIdx].url, nextIdx);
                preloadNextPhoto(photos, nextIdx, isCurrent);
                return;
            }
        }
        clearPhotoTransition();
        shownPhotoRef.current = null;
        setPhotoLayers([]);
    }, [clearPhotoTransition, preloadNextPhoto, showPhoto]);

    // 请求歌手写真数据
    React.useEffect(() => {
        const generation = ++requestGenerationRef.current;
        let isCancelled = false;
        const isCurrent = () => !isCancelled && requestGenerationRef.current === generation && isPageVisible();
        const cancel = () => { isCancelled = true; };
        if (!canLoadPhotos || !artistName.trim()) {
            setArtistPhotos([]);
            clearPhotoTransition();
            shownPhotoRef.current = null;
            setPhotoLayers([]);
            setReadyArtist('');
            setIsPhotoLoading(false);
            return cancel;
        }

        if (!pageVisible) { setIsPhotoLoading(false); return cancel; }

        const trimmedArtist = artistName.trim();
        setReadyArtist('');
        const getSavedIndex = (count) => {
            if (!count) return 0;
            const saved = ARTIST_PHOTO_PLAYBACK_PROGRESS.get(trimmedArtist);
            return (typeof saved === 'number' && saved >= 0) ? (saved % count) : 0;
        };

        if (ARTIST_PHOTO_CACHE.has(trimmedArtist)) {
            const cached = ARTIST_PHOTO_CACHE.get(trimmedArtist);
            setArtistPhotos(cached);
            const initialIdx = getSavedIndex(cached.length);
            setPhotoIndex(initialIdx);
            photoIndexRef.current = initialIdx;
            setIsPhotoLoading(false);
            void applyInitialPhoto(cached, initialIdx, isCurrent, trimmedArtist);
            return cancel;
        }

        setArtistPhotos([]);
        setIsPhotoLoading(true);

        const apiBase = getArtistPhotoApiBase();
        authenticatedFetch(`${apiBase}/api/artist-photo?name=${encodeURIComponent(trimmedArtist)}`, { credentials: 'include' })
            .then(res => res.json())
            .then((data) => {
                if (!isCurrent()) return;
                const photos = data?.data?.photos || [];
                ARTIST_PHOTO_CACHE.set(trimmedArtist, photos);
                setArtistPhotos(photos);
                const initialIdx = getSavedIndex(photos.length);
                setPhotoIndex(initialIdx);
                photoIndexRef.current = initialIdx;

                void applyInitialPhoto(photos, initialIdx, isCurrent, trimmedArtist);
            })
            .catch(err => {
                console.error('Failed to fetch artist photos:', err);
                if (isCurrent()) void applyInitialPhoto([], 0, isCurrent, trimmedArtist);
            })
            .finally(() => {
                if (isCurrent()) setIsPhotoLoading(false);
            });

        return cancel;
    }, [canLoadPhotos, artistName, applyInitialPhoto, clearPhotoTransition, pageVisible]);

    // 歌手写真多图自动轮播：严格在后台完全下载与完全解码位图后再触发 showPhoto 动画
    React.useEffect(() => {
        if (!canLoadPhotos || !pageVisible || readyArtist !== artistName.trim() || artistPhotos.length <= 1 || !isPlaying || isBuffering || suspendEffects || prefersReducedMotion) {
            if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
            return;
        }

        const trimmedArtist = artistName.trim();
        const generation = requestGenerationRef.current;
        let isCancelled = false;
        let rotationPending = false;
        const isCurrent = () => !isCancelled && requestGenerationRef.current === generation && isPageVisible();

        rotationTimerRef.current = setInterval(async () => {
            if (rotationPending || !isCurrent()) return;
            rotationPending = true;
            const currentIdx = photoIndexRef.current;
            try {
                for (let offset = 1; offset < artistPhotos.length; offset++) {
                    const nextIdx = (currentIdx + offset) % artistPhotos.length;
                    const nextPhoto = artistPhotos[nextIdx];
                    const success = await preloadAndDecodeImage(nextPhoto?.url, { isCurrent });
                    if (!isCurrent()) return;
                    if (success) {
                        ARTIST_PHOTO_PLAYBACK_PROGRESS.set(trimmedArtist, nextIdx);
                        photoIndexRef.current = nextIdx;
                        setPhotoIndex(nextIdx);
                        showPhoto(nextPhoto.url, nextIdx);
                        preloadNextPhoto(artistPhotos, nextIdx, isCurrent);
                        return;
                    }
                }
            } finally { rotationPending = false; }
        }, ARTIST_PHOTO_ROTATE_INTERVAL);

        return () => {
            isCancelled = true;
            if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
        };
    }, [canLoadPhotos, artistName, artistPhotos, isPlaying, isBuffering, suspendEffects, prefersReducedMotion, showPhoto, preloadNextPhoto, pageVisible, readyArtist]);

    return {
        artistPhotos,
        photoIndex,
        photoLayers,
        isPhotoLoading,
        hasPhotos: artistPhotos.length > 0,
        showPhotos: canLoadPhotos && photoLayers.length > 0,
    };
}
