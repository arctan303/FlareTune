import React from 'react';
import { t } from '../i18n/index.js';
import { imageLoadRegistry } from '../utils/imageLoadRegistry';
import { useImageInView } from '../hooks/useImageInView.js';
import { usePrivateMediaRouteRevision } from '../hooks/usePrivateMediaRouteRevision.js';
import { visibleImageSource } from '../utils/privateImageVisibility.js';

const isReadyCandidate = (cachedSrc) => Boolean(cachedSrc);

const getInitialState = (src, fallback) => {
    const requestedSrc = src || fallback;
    const cachedSrc = imageLoadRegistry.getReadySource(requestedSrc, fallback);
    return isReadyCandidate(cachedSrc)
        ? { requestedSrc, displaySrc: cachedSrc, status: 'displaying', reveal: false }
        : { requestedSrc, displaySrc: null, status: 'loading', reveal: false };
};

export default function LazyImage({ src, alt = t('专辑封面'), className = '', fallback = '/placeholder-album.svg', style = {}, eager = false }) {
    const requestedSrc = src || fallback;
    const routeRevision = usePrivateMediaRouteRevision();
    const [imageState, setImageState] = React.useState(() => getInitialState(src, fallback));
    const [prevSrc, setPrevSrc] = React.useState(requestedSrc);
    const imageRef = React.useRef(null);
    const cachedAtMount = imageLoadRegistry.getReadySource(requestedSrc, fallback);
    const initiallyInView = isReadyCandidate(cachedAtMount);
    const { containerRef, inView, setInView } = useImageInView({
        rootMargin: '300px',
        initiallyInView: eager || initiallyInView,
    });

    // 当 src 发生切换时，同步重置状态为 loading 骨架屏，杜绝旧图残影或逐行流式绘制
    if (requestedSrc !== prevSrc) {
        setPrevSrc(requestedSrc);
        const cached = imageLoadRegistry.getReadySource(requestedSrc, fallback);
        if (isReadyCandidate(cached)) {
            setImageState({ requestedSrc, displaySrc: cached, status: 'displaying', reveal: false });
            setInView(true);
        } else {
            setImageState({ requestedSrc, displaySrc: null, status: 'loading', reveal: false });
        }
    }

    React.useEffect(() => {
        if (!inView) return undefined;

        if (!requestedSrc) {
            setImageState({ requestedSrc: '', displaySrc: null, status: 'error', reveal: false });
            return undefined;
        }

        const cachedSrc = imageLoadRegistry.getReadySource(requestedSrc, fallback);
        if (imageLoadRegistry.isPrivateMediaUrl(requestedSrc) && !imageLoadRegistry.shouldLoadPrivately(requestedSrc)) {
            setImageState({ requestedSrc, displaySrc: null, status: 'loading', reveal: false });
            return undefined;
        }
        if (imageLoadRegistry.shouldLoadPrivately(requestedSrc) && !cachedSrc) {
            let cancelled = false;
            setImageState((current) => current.requestedSrc === requestedSrc
                ? { requestedSrc, displaySrc: null, status: 'loading', reveal: false } : current);
            void imageLoadRegistry.loadWithFallback(requestedSrc, fallback).then(({ url }) => {
                if (cancelled) return;
                setImageState((current) => current.requestedSrc === requestedSrc
                    ? { requestedSrc, displaySrc: url, status: 'displaying', reveal: false }
                    : current);
            }).catch(() => {
                if (cancelled) return;
                setImageState((current) => current.requestedSrc === requestedSrc
                    ? { requestedSrc, displaySrc: null, status: 'error', reveal: false }
                    : current);
            });
            return () => { cancelled = true; };
        }
        setImageState((current) => {
            if (current.requestedSrc !== requestedSrc || current.displaySrc === (cachedSrc || requestedSrc)) return current;
            return {
                requestedSrc,
                displaySrc: cachedSrc || requestedSrc,
                status: 'displaying',
                reveal: !cachedSrc,
            };
        });
        return undefined;
    }, [requestedSrc, fallback, inView, routeRevision]);

    const handleDisplayedImageError = (failedSrc) => {
        imageLoadRegistry.markError(failedSrc.startsWith('blob:') ? requestedSrc : failedSrc);
        setImageState((current) => {
            if (current.requestedSrc !== requestedSrc || current.displaySrc !== failedSrc) return current;
            if (fallback && failedSrc !== fallback) {
                return { requestedSrc, displaySrc: fallback, status: 'displaying', reveal: false };
            }
            return { requestedSrc, displaySrc: null, status: 'error', reveal: false };
        });
    };

    React.useLayoutEffect(() => {
        if (imageState.requestedSrc !== requestedSrc || imageState.status !== 'displaying' || !imageState.displaySrc) return;
        const image = imageRef.current;
        if (!image?.complete) return;
        if (image.naturalWidth === 0 || image.naturalHeight === 0) {
            handleDisplayedImageError(imageState.displaySrc);
            return;
        }
        imageLoadRegistry.markReady(imageState.displaySrc);
        setImageState((current) => current.requestedSrc === requestedSrc && current.displaySrc === imageState.displaySrc
            ? { ...current, status: 'ready' }
            : current);
    }, [requestedSrc, imageState.requestedSrc, imageState.displaySrc, imageState.status]);

    const displayedSrc = imageState.requestedSrc === requestedSrc
        ? visibleImageSource(requestedSrc, imageState.displaySrc, fallback, imageLoadRegistry) : null;
    const isReady = imageState.requestedSrc === requestedSrc && imageState.status === 'ready' && Boolean(displayedSrc);

    return (
        <div
            ref={containerRef}
            className={`lazy-image relative overflow-hidden ${className}`}
            data-image-state={displayedSrc ? imageState.status : imageState.status === 'error' ? 'error' : 'loading'}
            style={style}
        >
            {!isReady && (
                <div
                    className={`image-loading-placeholder absolute inset-0 ${imageState.status === 'error' ? 'is-error' : ''}`}
                    aria-hidden="true"
                />
            )}
            {displayedSrc && (
                <img
                    ref={imageRef}
                    key={displayedSrc}
                    src={displayedSrc}
                    alt={alt}
                    draggable="false"
                    decoding="async"
                    onLoad={(event) => {
                        if (event.currentTarget.naturalWidth === 0 || event.currentTarget.naturalHeight === 0) {
                            handleDisplayedImageError(displayedSrc);
                            return;
                        }
                        imageLoadRegistry.markReady(displayedSrc);
                        setImageState((current) => current.requestedSrc === requestedSrc && current.displaySrc === displayedSrc
                            ? { ...current, status: 'ready' }
                            : current);
                    }}
                    onError={() => handleDisplayedImageError(displayedSrc)}
                    className={`lazy-image__asset absolute inset-0 h-full w-full object-cover ${isReady ? (imageState.reveal ? 'is-revealing' : 'is-ready') : 'is-pending'}`}
                />
            )}
        </div>
    );
}
