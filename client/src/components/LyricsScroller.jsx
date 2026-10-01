import { t } from '../i18n/index.js';
import React from 'react';
import { VolumeX, Volume2, Loader2 } from 'lucide-react';
import InterludeHost from './lyrics/InterludeHost';
import SyncedLyricText from './lyrics/SyncedLyricText';

import { useLyricSurfacePresentation } from './lyrics/lyricSurfacePresentation.js';
import { useMediaQuery } from './fullscreen/useMediaQuery';

const LYRIC_STATUS_LINES = new Set(['纯音乐，请欣赏', '暂无歌词', '歌词加载失败']);

export default function LyricsScroller({
    lyrics, currentLyricIndex, audioRef, 
    isLyricsLoading, translationEnabled, canTranslate, translationState, toggleTranslation,
    volume, setVolume, isFullScreen, currentSong,
    controlsBottomOffset,
    isControlsHidden = false,
    onWakeControls,
    lyricSyncMode = 'line',
    lyricIntro = null,
    surfaceVisible = true,
}) {
    const lyricsContainerRef = React.useRef(null);
    const [isUserScrolling, setIsUserScrolling] = React.useState(false);
    const [isVolumePanelOpen, setIsVolumePanelOpen] = React.useState(false);
    const [prevVolume, setPrevVolume] = React.useState(volume > 0 ? volume : 0.8);
    const volumeTimerRef = React.useRef(null);
    const scrollTimeoutRef = React.useRef(null);
    const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', false);
    const iconStrokeWidth = 1.75;
    const resolvedTranslationState = translationState || (canTranslate ? 'ready' : 'unavailable');
    const translationPending = resolvedTranslationState === 'pending';
    const translationReady = resolvedTranslationState === 'ready';

    const openVolumePanel = React.useCallback(() => {
        if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
        setIsVolumePanelOpen(true);
    }, []);

    const scheduleCloseVolumePanel = React.useCallback((delay = 2800) => {
        if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
        volumeTimerRef.current = setTimeout(() => {
            setIsVolumePanelOpen(false);
        }, delay);
    }, []);

    const cancelCloseVolumePanel = React.useCallback(() => {
        if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
    }, []);

    const handleVolumeButtonClick = React.useCallback((e) => {
        e?.stopPropagation?.();
        if (!isVolumePanelOpen) {
            // 第一次点击：弹出音量控制条，不切换静音
            openVolumePanel();
            scheduleCloseVolumePanel(3500);
            return;
        }
        // 已弹出状态下再次点击：切换静音与恢复
        if (volume === 0) {
            const restored = prevVolume || 0.8;
            setVolume(restored);
            if (audioRef?.current) audioRef.current.volume = restored;
        } else {
            setPrevVolume(volume);
            setVolume(0);
            if (audioRef?.current) audioRef.current.volume = 0;
        }
        openVolumePanel();
        scheduleCloseVolumePanel(3000);
    }, [isVolumePanelOpen, volume, prevVolume, setVolume, audioRef, openVolumePanel, scheduleCloseVolumePanel]);

    React.useEffect(() => {
        return () => {
            if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
        };
    }, []);

    const lyricPresentation = useLyricSurfacePresentation({
        lyrics,
        currentLyricIndex,
        lyricIntro,
        lyricSyncMode,
        surfaceVisible,
    });
    const displayedLyricIndex = lyricPresentation.index >= 0
        ? lyricPresentation.index
        : currentLyricIndex;

    const userInteractStart = () => {
        setIsUserScrolling(true);
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
    
    const userInteractEnd = () => {
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = setTimeout(() => {
            setIsUserScrolling(false);
        }, 1500); 
    };

    const scrollAnimRef = React.useRef(null);
    const scrollLayoutFrameRef = React.useRef(null);
    // 首次进入全屏时跳过平滑滚动动画，直接定位当前行，避免与滑入动效抢占主线程
    const hasPositionedOnEnterRef = React.useRef(false);
    // 唤醒时间戳锁：在沉浸隐藏唤醒后的 450ms 内，拦截所有触屏延迟合成的 click 事件，杜绝误触发歌词跳转
    const lastWakeTimestampRef = React.useRef(0);
    const prevControlsHiddenRef = React.useRef(isControlsHidden);

    React.useEffect(() => {
        if (prevControlsHiddenRef.current && !isControlsHidden) {
            // 刚从隐藏状态唤醒瞬间立即上锁，彻底封死 touch 与 click 之间的事件穿透
            lastWakeTimestampRef.current = Date.now();
        }
        prevControlsHiddenRef.current = isControlsHidden;
    }, [isControlsHidden]);

    const handleLineClick = React.useCallback((time) => {
        const now = Date.now();
        if (isControlsHidden || (now - lastWakeTimestampRef.current < 450)) {
            // 沉浸隐藏状态或刚唤醒保护期内：首击仅唤醒控件，不误触发时间跳转
            lastWakeTimestampRef.current = now;
            if (onWakeControls) onWakeControls();
            return;
        }
        if (!Number.isFinite(time)) return;
        if (audioRef.current) audioRef.current.currentTime = time;
        setIsUserScrolling(false);
        if (scrollTimeoutRef.current) {
            clearTimeout(scrollTimeoutRef.current);
            scrollTimeoutRef.current = null;
        }
    }, [audioRef, isControlsHidden, onWakeControls]);

    React.useEffect(() => {
        const handleGlobalMouseUp = () => {
            if (isUserScrolling) {
                userInteractEnd();
            }
        };
        window.addEventListener('mouseup', handleGlobalMouseUp, { passive: true });
        return () => {
            window.removeEventListener('mouseup', handleGlobalMouseUp);
            if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
            if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
        };
    }, [isUserScrolling]);

    React.useLayoutEffect(() => {
        if (scrollLayoutFrameRef.current) {
            window.cancelAnimationFrame(scrollLayoutFrameRef.current);
            scrollLayoutFrameRef.current = null;
        }
        if (scrollAnimRef.current) {
            window.cancelAnimationFrame(scrollAnimRef.current);
            scrollAnimRef.current = null;
        }
        if (!isFullScreen || !surfaceVisible) {
            hasPositionedOnEnterRef.current = false;
            return;
        }
        if (!lyricsContainerRef.current || isUserScrolling) return;
        const container = lyricsContainerRef.current;

        const scrollToActive = () => {
            const lyricWrapper = container.firstElementChild;
            if (lyrics.length <= 1) {
                container.scrollTop = 0;
                return;
            }
            if (lyricWrapper) {
                const activeEl = lyricWrapper.children[displayedLyricIndex];
                if (activeEl) {
                    // 布局值一次性读取：仅动画启动前访问 offsetTop/clientHeight/scrollTop，
                    // 动画帧回调只写 scrollTop，避免逐帧强制回流（layout thrash）。
                    // 大屏纵向视平线（精准对齐左侧专辑封面中心）
                    // 锚点取整行高度（含折行第二段与翻译行），换行/翻译切换导致的行高变化
                    // 不再让目标位置跳变，避免平板换行完成瞬间的闪烁
                    const targetTop = Math.max(
                        0,
                        activeEl.offsetTop - (container.clientHeight * 0.44) + (activeEl.offsetHeight / 2)
                    );

                    // 首次进入全屏：跳过 680ms 平滑滚动，直接定位当前行。
                    // 滑入转场期间不再每帧驱动 scrollTop 重绘，切入切出不再卡顿。
                    if (prefersReducedMotion || !hasPositionedOnEnterRef.current) {
                        if (scrollAnimRef.current) {
                            window.cancelAnimationFrame(scrollAnimRef.current);
                            scrollAnimRef.current = null;
                        }
                        hasPositionedOnEnterRef.current = true;
                        container.scrollTop = targetTop;
                        return;
                    }

                    // Apple Music 60FPS 丝滑阻尼单向插值连续过渡，零停顿断点
                    const startTop = container.scrollTop;
                    const distance = targetTop - startTop;
                    if (Math.abs(distance) < 1) return;

                    const startTime = performance.now();
                    const duration = 680; // 680ms 极致平滑缓动
                    const easeOutCubic = (t) => (--t) * t * t + 1;

                    const step = (currentTime) => {
                        if (isUserScrolling) return;
                        const elapsed = currentTime - startTime;
                        const progress = Math.min(elapsed / duration, 1);
                        container.scrollTop = startTop + (distance * easeOutCubic(progress));
                        if (progress < 1) {
                            scrollAnimRef.current = requestAnimationFrame(step);
                        } else {
                            scrollAnimRef.current = null;
                        }
                    };

                    if (scrollAnimRef.current) window.cancelAnimationFrame(scrollAnimRef.current);
                    scrollAnimRef.current = requestAnimationFrame(step);
                } else if (displayedLyricIndex === 0) {
                    container.scrollTop = 0;
                }
            }
        };

        const scheduleScrollToActive = () => {
            if (scrollLayoutFrameRef.current) {
                window.cancelAnimationFrame(scrollLayoutFrameRef.current);
                scrollLayoutFrameRef.current = null;
            }
            if (prefersReducedMotion) {
                scrollToActive();
                return;
            }
            scrollLayoutFrameRef.current = window.requestAnimationFrame(() => {
                scrollLayoutFrameRef.current = null;
                scrollToActive();
            });
        };

        scheduleScrollToActive();
        const handleWindowResize = () => {
            if (!isUserScrolling) {
                scheduleScrollToActive();
            }
        };
        window.addEventListener('resize', handleWindowResize, { passive: true });

        let resizeObserver = null;
        const lyricWrapper = container.firstElementChild;
        if (typeof ResizeObserver !== 'undefined' && lyricWrapper) {
            resizeObserver = new ResizeObserver(() => {
                if (!isUserScrolling) {
                    scheduleScrollToActive();
                }
            });
            resizeObserver.observe(lyricWrapper);
        }

        return () => {
            if (scrollLayoutFrameRef.current) {
                window.cancelAnimationFrame(scrollLayoutFrameRef.current);
                scrollLayoutFrameRef.current = null;
            }
            window.removeEventListener('resize', handleWindowResize);
            if (resizeObserver) resizeObserver.disconnect();
            if (scrollAnimRef.current) window.cancelAnimationFrame(scrollAnimRef.current);
        };
    }, [displayedLyricIndex, isFullScreen, currentSong?.id, isUserScrolling, lyrics, prefersReducedMotion, surfaceVisible, translationEnabled]);

    return (
        <div className="classic-lyrics w-full flex-1 flex flex-col h-full pt-0 pb-0 lg:pt-12 lg:pb-0 px-1 sm:px-4 lg:px-0 relative min-w-0">
            {/* 恢复 45c8e95 的歌词边界：滚动视口负责自然渐隐，逐行滤镜始终
                保持明确值，避免性能重构时期因滤镜层频繁增删而放大遮罩重合成。 */}
            <div className="relative flex-1 min-h-0 flex flex-col">
                <div
                    className="classic-lyrics__viewport flex-1 overflow-y-auto overscroll-y-contain no-scrollbar text-center relative"
                    style={{
                        maskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 82%, transparent 98%)',
                        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 82%, transparent 98%)',
                    }}
                    ref={lyricsContainerRef}
                    onWheel={() => { userInteractStart(); userInteractEnd(); }}
                    onTouchMove={() => { userInteractStart(); userInteractEnd(); }}
                    onTouchStart={() => {
                        if (isControlsHidden) {
                            lastWakeTimestampRef.current = Date.now();
                            if (onWakeControls) onWakeControls();
                        }
                        userInteractStart();
                    }}
                    onMouseDown={() => { userInteractStart(); }}
                    onMouseUp={() => { userInteractEnd(); }}
                    onClick={() => {
                        if (isControlsHidden) {
                            lastWakeTimestampRef.current = Date.now();
                            if (onWakeControls) onWakeControls();
                        }
                    }}
                    data-no-swipe
                >
                    {isLyricsLoading ? (
                        <div className="classic-lyrics__loading absolute inset-0 flex flex-col items-center justify-center pt-20">
                            <div className="classic-lyrics__spinner w-10 h-10 border-[3px] border-white/10 border-t-white/80 rounded-full animate-spin mb-6"></div>
                            <div className="flex flex-col items-center space-y-3">
                                <div className="classic-lyrics__skeleton h-4 w-48 bg-white/10 rounded-full overflow-hidden relative">
                                    <div className="classic-lyrics__loading-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent w-[200%] animate-[shimmer_1.5s_infinite] -translate-x-full"></div>
                                </div>
                                <div className="classic-lyrics__skeleton h-4 w-32 bg-white/10 rounded-full overflow-hidden relative">
                                    <div className="classic-lyrics__loading-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent w-[200%] animate-[shimmer_1.5s_infinite] -translate-x-full" style={{animationDelay: '0.2s'}}></div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className={`classic-lyrics__lines ${lyrics.length <= 1 ? 'min-h-full flex flex-col justify-center items-center py-12' : 'pt-[40vh] pb-[46vh] space-y-4 md:space-y-5'}`}>
                            {lyrics.map((lrc, index) => {
                                const isActive = index === displayedLyricIndex;
                                const diff = index - displayedLyricIndex;
                                const isIntroRow = lyricPresentation.kind === 'intro' && index === 0;
                                const sourceLine = isIntroRow ? lyricPresentation.line : lrc;
                                const displayLine = LYRIC_STATUS_LINES.has(sourceLine?.text)
                                    ? { ...sourceLine, text: t(sourceLine.text) } : sourceLine;
                                const lines = String(displayLine?.text || '').split('\n');
                                const canSeek = Number.isFinite(lrc.time);
                                let lineStyle = {};
                                let lineClass = '';

                                if (isUserScrolling || lyrics.length <= 2) {
                                    lineClass = isActive ? 'opacity-100' : 'opacity-40 hover:opacity-[0.85]';
                                    lineStyle = {
                                        filter: 'blur(0px)',
                                        textShadow: isActive ? '0 0 24px rgba(255,255,255,0.35), 0 4px 16px rgba(0,0,0,0.7)' : 'none',
                                        transition: 'opacity 500ms ease-out, filter 500ms ease-out',
                                    };
                                } else if (diff < -1) {
                                    lineClass = 'opacity-0 pointer-events-none -translate-y-2';
                                    lineStyle = {
                                        filter: 'blur(2.5px) saturate(0.3)',
                                        transition: 'opacity 600ms ease-out, filter 600ms ease-out, transform 600ms ease-out',
                                    };
                                } else if (diff === -1) {
                                    lineClass = 'opacity-[0.2] -translate-y-1';
                                    lineStyle = {
                                        filter: 'blur(1px) saturate(0.4)',
                                        transition: 'all 600ms cubic-bezier(0.22, 1, 0.36, 1)',
                                    };
                                } else if (diff === 0) {
                                    lineClass = 'opacity-100 translate-y-0';
                                    lineStyle = {
                                        filter: 'blur(0px)',
                                        textShadow: '0 0 24px rgba(255,255,255,0.35), 0 4px 16px rgba(0,0,0,0.7)',
                                        transition: 'all 600ms cubic-bezier(0.22, 1, 0.36, 1)',
                                    };
                                } else {
                                    lineClass = 'opacity-[0.5] translate-y-0 hover:opacity-[0.9]';
                                    lineStyle = {
                                        filter: 'blur(0.6px) saturate(0.5)',
                                        transition: 'all 600ms cubic-bezier(0.22, 1, 0.36, 1)',
                                    };
                                }

                                return (
                                    <div
                                        key={index}
                                        data-active={isActive}
                                        style={lineStyle}
                                        className={`classic-lyrics__line ${canSeek ? 'cursor-pointer' : 'cursor-default'} text-left md:text-left ${lineClass}`}
                                        onClick={canSeek ? () => handleLineClick(lrc.time) : undefined}
                                    >
                                        <InterludeHost
                                            audioRef={audioRef}
                                            lyrics={lyrics}
                                            currentLyricIndex={displayedLyricIndex}
                                            lineIndex={index}
                                            isActive={isActive}
                                            isUserScrolling={isUserScrolling}
                                            onSeekTime={handleLineClick}
                                            surfaceVisible={surfaceVisible}
                                            syncMode={lyricSyncMode}
                                        >
                                            {lines.map((line, idx) => (
                                                 <p
                                                    key={idx}
                                                    className={`classic-lyrics__text break-words whitespace-pre-wrap leading-snug tracking-normal ${
                                                        idx === 0
                                                            ? `text-3xl md:text-3xl font-sans ${isActive ? 'text-white font-extrabold' : 'text-white/80 font-bold'}`
                                                            : `text-xl md:text-xl mt-1 ${isActive ? 'text-white/90' : 'text-white/50'}`
                                                    }`}
                                                 >
                                                    <SyncedLyricText
                                                        line={displayLine}
                                                        text={line}
                                                        active={isActive}
                                                        visible={surfaceVisible}
                                                        syncMode={lyricSyncMode}
                                                        surface="classic"
                                                    />
                                                 </p>
                                            ))}
                                            {(!isIntroRow && lrc.translation && translationEnabled) && (
                                                <p
                                                    className={`classic-lyrics__translation text-base md:text-lg mt-1 leading-normal ${
                                                        isActive ? 'text-gray-300/80 font-medium' : 'text-gray-400/50'
                                                    }`}
                                                    style={{ textShadow: isActive ? '0 0 12px rgba(255,255,255,0.2), 0 2px 6px rgba(0,0,0,0.5)' : 'none' }}
                                                >
                                                    {lrc.translation}
                                                </p>
                                            )}
                                        </InterludeHost>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            <div
                className="classic-lyrics__tools-wrapper w-full flex justify-start items-center flex-shrink-0 pt-0.5 pb-0.5 z-10"
                onClick={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onTouchEnd={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                    paddingBottom: (typeof controlsBottomOffset === 'number' && controlsBottomOffset > 0)
                        ? `${controlsBottomOffset}px`
                        : undefined
                }}
            >
                <div className="classic-lyrics__tools flex items-center gap-2.5 sm:gap-3 text-gray-400 transition-all">
                    {canTranslate && (
                        <button
                            type="button"
                            aria-label={translationPending ? t("歌词翻译补全中") : translationReady ? t("切换歌词翻译") : t("补全歌词翻译")}
                            aria-busy={translationPending || undefined}
                            disabled={translationPending}
                            data-active={translationReady && translationEnabled}
                            data-translation-state={resolvedTranslationState}
                            onClick={(e) => {
                                e.stopPropagation();
                                toggleTranslation?.();
                            }}
                            className={`lyrics-translation-action classic-lyrics__tool classic-lyrics__tool--text relative h-6 px-2 inline-flex cursor-pointer items-center justify-center rounded-lg text-[11px] font-medium transition-all disabled:cursor-wait shrink-0 ${
                                translationReady && translationEnabled
                                    ? 'text-blue-300 bg-blue-500/20 font-semibold shadow-[0_0_6px_rgba(59,130,246,0.3)]'
                                    : translationReady
                                        ? 'text-blue-200/75 bg-blue-500/10 hover:text-blue-100'
                                        : resolvedTranslationState === 'failed'
                                            ? 'text-amber-200/80 bg-amber-400/10 hover:text-amber-100'
                                            : 'text-white/45 hover:text-white/70 bg-white/5 hover:bg-white/10'
                            }`}
                            title={translationPending
                                ? t("正在补全歌词翻译")
                                : translationReady
                                    ? (translationEnabled ? t("已显示歌词翻译（点击隐藏）") : t("显示歌词翻译"))
                                    : resolvedTranslationState === 'failed' ? t("补全失败，点击重试") : t("点击补全歌词翻译")}
                        >{t("译")}</button>
                    )}
                    <div 
                        className="classic-lyrics__volume relative flex items-center justify-center"
                        onMouseEnter={openVolumePanel}
                        onMouseLeave={() => scheduleCloseVolumePanel(1200)}
                        onWheel={(e) => {
                            e?.stopPropagation?.();
                            const delta = e.deltaY < 0 ? 0.05 : -0.05;
                            const nextVol = Math.max(0, Math.min(1, Number((volume + delta).toFixed(2))));
                            setVolume(nextVol);
                            if (audioRef?.current) audioRef.current.volume = nextVol;
                            openVolumePanel();
                            scheduleCloseVolumePanel(3000);
                        }}
                    >
                        <button
                            aria-label={volume === 0 ? t("恢复音量") : t("静音")}
                            onClick={(e) => {
                                e?.stopPropagation?.();
                                handleVolumeButtonClick(e);
                            }}
                            className="classic-lyrics__tool hover:text-white hover:scale-110 transition-all focus:outline-none flex items-center justify-center p-1 cursor-pointer active:scale-95"
                            title={isVolumePanelOpen ? (volume === 0 ? t("点击恢复音量") : t("点击静音")) : t("当前音量 {p0}%（点击展开滑块）", { p0: (Math.round(volume * 100)) })}
                        >
                            {volume === 0 ? <VolumeX size={20} strokeWidth={iconStrokeWidth} /> : <Volume2 size={20} strokeWidth={iconStrokeWidth} />}
                        </button>

                        {/* 往右侧水平展开的音频调节浮层容器 (包含悬停桥接区，彻底防止中途断触消失) */}
                        <div 
                            className={`absolute left-full top-1/2 -translate-y-1/2 pl-2.5 flex items-center pointer-events-none transition-all duration-300 ${isVolumePanelOpen ? 'opacity-100 translate-x-0 pointer-events-auto' : 'opacity-0 -translate-x-2 pointer-events-none'}`}
                            onMouseEnter={cancelCloseVolumePanel}
                            onMouseLeave={() => scheduleCloseVolumePanel(1200)}
                        >
                            <div 
                                className="h-7 px-2.5 bg-black/65 backdrop-blur-2xl rounded-full shadow-[0_8px_24px_rgba(0,0,0,0.55)] flex items-center gap-2 select-none"
                                onClick={(e) => e.stopPropagation()}
                            >
                                {/* 纯净的白色占比水平胶囊轨条：无圆点手柄，左到右填充 */}
                                <div className="w-20 h-1.5 bg-white/20 rounded-full overflow-hidden flex relative pointer-events-none">
                                    <div 
                                        className="h-full bg-white rounded-full transition-all duration-75 shadow-[0_0_8px_rgba(255,255,255,0.4)]"
                                        style={{ width: `${Math.round(volume * 100)}%` }}
                                    />
                                </div>

                                {/* 覆盖在上方的透明 range，处理点击与拖拽手势 */}
                                <input
                                    type="range"
                                    min="0" max="1" step="0.01"
                                    value={volume}
                                    onPointerDown={cancelCloseVolumePanel}
                                    onPointerUp={() => scheduleCloseVolumePanel(2500)}
                                    onTouchStart={cancelCloseVolumePanel}
                                    onTouchEnd={() => scheduleCloseVolumePanel(2500)}
                                    onChange={(e) => {
                                        const newVol = parseFloat(e.target.value);
                                        setVolume(newVol);
                                        if (audioRef?.current) audioRef.current.volume = newVol;
                                        openVolumePanel();
                                    }}
                                    aria-label={t("音量")}
                                    className="absolute inset-0 opacity-0 cursor-pointer"
                                />

                                <span className="text-[10px] font-mono font-medium text-white/75 select-none tracking-tight w-5 text-right">
                                    {Math.round(volume * 100)}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
