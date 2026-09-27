import React from 'react';
import { getApiBaseUrl } from '../services/apiBase.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';
import { useUIStore } from '../store/useUIStore.js';

export const ARTIST_PHOTO_ROTATE_INTERVAL = 16000; // 16 秒平滑轮播下一张写真
export const ARTIST_PHOTO_CACHE = new Map(); // 客户端内存缓存写真元数据
export const ARTIST_PHOTO_IMAGE_CACHE = new Map(); // 预载解码就绪缓存 (url -> boolean)
export const ARTIST_PHOTO_PLAYBACK_PROGRESS = new Map(); // 记录每个歌手上次轮播到的写真索引

export const getArtistPhotoApiBase = () => getApiBaseUrl();

/**
 * 提前将图片下载并在浏览器后台内存中完全解码 (Fully Decoded Bitmap)
 * 严格使用 onload + img.decode() 双重保障，确保切换时位图 100% 存在于内存中，
 * 杜绝在 DOM 挂载时出现任何从上到下的逐行扫描 (Progressive/Scanline) 流式加载。
 */
export function preloadAndDecodeImage(url) {
    if (!url) return Promise.resolve(false);
    const cached = ARTIST_PHOTO_IMAGE_CACHE.get(url);
    if (cached === true) return Promise.resolve(true);
    if (cached && typeof cached.then === 'function') return cached;

    const pending = new Promise((resolve) => {
        const image = new Image();
        image.referrerPolicy = 'no-referrer';
        let settled = false;
        let timeoutId = null;

        const finish = (success) => {
            if (settled) return;
            settled = true;
            if (timeoutId !== null) clearTimeout(timeoutId);
            ARTIST_PHOTO_IMAGE_CACHE.set(url, success);
            resolve(success);
        };

        image.onload = async () => {
            try {
                if (typeof image.decode === 'function') {
                    await image.decode();
                }
                finish(true);
            } catch {
                // onload 已经成功，说明资源已在浏览器缓存中
                finish(true);
            }
        };

        image.onerror = () => finish(false);
        image.src = url;

        // 12 秒超时保护
        timeoutId = setTimeout(() => finish(false), 12000);
    });
    ARTIST_PHOTO_IMAGE_CACHE.set(url, pending);
    return pending;
}

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
    const authenticated = useUIStore((state) => Boolean(state.authSession?.authenticated));
    const canLoadPhotos = enabled && authenticated;
    const [artistPhotos, setArtistPhotos] = React.useState([]);
    const [photoIndex, setPhotoIndex] = React.useState(0);
    const [photoLayers, setPhotoLayers] = React.useState([]);
    const [isPhotoLoading, setIsPhotoLoading] = React.useState(false);
    const rotationTimerRef = React.useRef(null);
    const crossFadeTimerRef = React.useRef(null);
    const fadeOutRafRef = React.useRef(null);
    const layerIdRef = React.useRef(0);
    const photoIndexRef = React.useRef(0);

    // 保持 photoIndexRef 同步
    React.useEffect(() => {
        photoIndexRef.current = photoIndex;
    }, [photoIndex]);

    const showPhoto = React.useCallback((url, index = 0) => {
        if (!url) return;
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
        const frame = requestAnimationFrame(() => requestAnimationFrame(reveal));
        fadeOutRafRef.current = frame;

        if (crossFadeTimerRef.current) clearTimeout(crossFadeTimerRef.current);
        crossFadeTimerRef.current = setTimeout(() => {
            setPhotoLayers((prev) => prev.filter((layer) => layer.id === id));
        }, 1600);
    }, [prefersReducedMotion]);

    const applyInitialPhoto = React.useCallback(async (photos, initialIndex = 0) => {
        if (!photos || photos.length === 0) {
            setPhotoLayers([]);
            return;
        }
        const idx = (initialIndex >= 0 && initialIndex < photos.length) ? initialIndex : 0;
        const firstPhoto = photos[idx];
        if (firstPhoto?.url) {
            // 首张图片先等待后台完全下载并解码完成，再挂载并展示
            await preloadAndDecodeImage(firstPhoto.url);
            showPhoto(firstPhoto.url, idx);
        }
        // 后台并发预载所有其余写真
        photos.forEach((p, i) => {
            if (i !== idx) preloadAndDecodeImage(p.url);
        });
    }, [showPhoto]);

    // 请求歌手写真数据
    React.useEffect(() => {
        if (!canLoadPhotos || !artistName.trim()) {
            setArtistPhotos([]);
            setPhotoLayers([]);
            return;
        }

        const trimmedArtist = artistName.trim();
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
            applyInitialPhoto(cached, initialIdx);
            return;
        }

        let isCancelled = false;
        setIsPhotoLoading(true);

        const apiBase = getArtistPhotoApiBase();
        authenticatedFetch(`${apiBase}/api/artist-photo?name=${encodeURIComponent(trimmedArtist)}`, { credentials: 'include' })
            .then(res => res.json())
            .then(async (data) => {
                if (isCancelled) return;
                const photos = data?.data?.photos || [];
                ARTIST_PHOTO_CACHE.set(trimmedArtist, photos);
                setArtistPhotos(photos);
                const initialIdx = getSavedIndex(photos.length);
                setPhotoIndex(initialIdx);
                photoIndexRef.current = initialIdx;

                applyInitialPhoto(photos, initialIdx);
            })
            .catch(err => {
                console.error('Failed to fetch artist photos:', err);
                if (!isCancelled) applyInitialPhoto([]);
            })
            .finally(() => {
                if (!isCancelled) setIsPhotoLoading(false);
            });

        return () => {
            isCancelled = true;
        };
    }, [canLoadPhotos, artistName, applyInitialPhoto]);

    // 歌手写真多图自动轮播：严格在后台完全下载与完全解码位图后再触发 showPhoto 动画
    React.useEffect(() => {
        if (!canLoadPhotos || artistPhotos.length <= 1 || !isPlaying || isBuffering || suspendEffects || prefersReducedMotion) {
            if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
            return;
        }

        const trimmedArtist = artistName.trim();
        artistPhotos.forEach((p) => preloadAndDecodeImage(p.url));

        rotationTimerRef.current = setInterval(async () => {
            const currentIdx = photoIndexRef.current;
            const nextIdx = (currentIdx + 1) % artistPhotos.length;
            const nextPhoto = artistPhotos[nextIdx];

            if (nextPhoto?.url) {
                // 关键点：在触发转场动画前，先强制完成下一张图片的后台预载与完全解码
                const success = await preloadAndDecodeImage(nextPhoto.url);
                if (success) {
                    ARTIST_PHOTO_PLAYBACK_PROGRESS.set(trimmedArtist, nextIdx);
                    photoIndexRef.current = nextIdx;
                    setPhotoIndex(nextIdx);
                    showPhoto(nextPhoto.url, nextIdx);
                }
            }
        }, ARTIST_PHOTO_ROTATE_INTERVAL);

        return () => {
            if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
            if (crossFadeTimerRef.current) clearTimeout(crossFadeTimerRef.current);
            if (fadeOutRafRef.current) cancelAnimationFrame(fadeOutRafRef.current);
        };
    }, [canLoadPhotos, artistName, artistPhotos, isPlaying, isBuffering, suspendEffects, prefersReducedMotion, showPhoto]);

    return {
        artistPhotos,
        photoIndex,
        photoLayers,
        isPhotoLoading,
        hasPhotos: artistPhotos.length > 0,
        showPhotos: canLoadPhotos && photoLayers.length > 0,
    };
}
