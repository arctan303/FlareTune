import { t } from '../../i18n/index.js';
import React from 'react';
import { useArtistPhotos } from '../../hooks/useArtistPhotos';
import { usePrivateMediaSource } from '../../hooks/usePrivateMediaSource.js';

export default function ImmersiveBackground({
    theme,
    artistName = '',
    coverUrl = '',
    prefersReducedMotion,
    isPlaying,
    isBuffering,
    mediaEnabled = true,
    active = true,
    suspendEffects = false,
}) {
    const { photoLayers, isPhotoLoading, showPhotos } = useArtistPhotos({
        artistName,
        enabled: Boolean(artistName.trim()),
        isPlaying,
        isBuffering,
        suspendEffects,
        prefersReducedMotion,
    });
    const isActive = mediaEnabled && active && isPlaying && !isBuffering;

    const isPhotoMotionActive = isPlaying && !isBuffering && !suspendEffects && !prefersReducedMotion;
    const resolvedCoverUrl = usePrivateMediaSource(coverUrl);

    const renderArtistPhotoLayer = () => (
        <div className="absolute inset-0 overflow-hidden bg-black select-none pointer-events-none" aria-hidden="true">
            {/* 写真图层栈：外层容器承载入场/退场的电影级景深缓动与柔焦消散，内层图片承载 20s 舞台慢镜头 */}
            {photoLayers.map((layer) => {
                const animName = (layer.index % 2 === 0) ? 'kenburnsZoomIn' : 'kenburnsZoomOut';
                return (
                    <div
                        key={layer.id}
                        className="absolute inset-0 w-full h-full overflow-hidden transition-all duration-[1500ms] ease-[cubic-bezier(0.16,1,0.3,1)] will-change-transform"
                        style={{
                            opacity: layer.opacity,
                            transform: layer.transform || 'scale(1) translate3d(0, 0, 0)',
                            filter: layer.filter || 'none',
                        }}
                    >
                        <img
                            src={layer.url}
                            alt=""
                            referrerPolicy="no-referrer"
                            className="absolute inset-0 w-full h-full object-cover brightness-[0.72] will-change-transform"
                            style={{
                                animation: prefersReducedMotion ? 'none' : `${animName} 20s infinite alternate ease-in-out`,
                                animationPlayState: isPhotoMotionActive ? 'running' : 'paused',
                            }}
                        />
                    </div>
                );
            })}

            {/* 歌手写真专属舞台氛围光与影院暗角 */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/60" />
            <div
                className="absolute inset-0 opacity-40 pointer-events-none"
                style={{
                    background: 'radial-gradient(circle at 50% 50%, rgba(236, 72, 153, 0.25) 0%, rgba(59, 130, 246, 0.15) 45%, transparent 70%)'
                }}
            />
        </div>
    );

    return (
        <>
            {/* 写真不可用时只用暗化封面承托歌词，不再载入风景视频。 */}
            <div className="absolute inset-0 overflow-hidden bg-black pointer-events-none" aria-hidden="true">
                {!showPhotos && resolvedCoverUrl && <img src={resolvedCoverUrl} alt="" className="absolute inset-0 h-full w-full object-cover scale-110 blur-2xl brightness-[0.35]" />}
            </div>

            {showPhotos && renderArtistPhotoLayer()}

            {!showPhotos && isPhotoLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/20 pointer-events-none">
                    <span className="text-white/40 text-xs">{t("正在加载歌手写真…")}</span>
                </div>
            )}

            <div className={`absolute inset-0 bg-gradient-to-b ${theme.overlay} pointer-events-none`} />
            <div className={`absolute inset-0 bg-[radial-gradient(circle_at_50%_62%,transparent_0%,rgba(0,0,0,0.18)_42%,rgba(0,0,0,0.58)_100%)] transition-opacity duration-700 pointer-events-none ${isActive ? 'opacity-100' : 'opacity-90'}`} />
            <div className={`absolute inset-0 bg-black transition-opacity duration-700 pointer-events-none ${isActive ? 'opacity-0' : 'opacity-[0.08]'}`} />
        </>
    );
}
