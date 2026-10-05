import { t } from '../../i18n/index.js';
import React from 'react';
import { createPortal } from 'react-dom';
import { Volume2, VolumeX } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useShallow } from 'zustand/react/shallow';
import { usePlayerInteractionLock } from '../../hooks/usePlayerAutoHide.js';

export default function VolumeControl({ isExpanded = false }) {
    const { volume, setVolume, audioRef } = usePlayerStore(useShallow((state) => ({
        volume: state.volume,
        setVolume: state.setVolume,
        audioRef: state.audioRef,
    })));
    const [isMuted, setIsMuted] = React.useState(false);
    const [prevVolume, setPrevVolume] = React.useState(volume > 0 ? volume : 0.8);
    const [isVolumePanelOpen, setIsVolumePanelOpen] = React.useState(false);
    const [coords, setCoords] = React.useState({ left: 0, bottom: 0 });
    const buttonRef = React.useRef(null);
    const panelRef = React.useRef(null);
    const draggingRef = React.useRef(false);
    const volumeTimerRef = React.useRef(null);
    usePlayerInteractionLock(isExpanded && isVolumePanelOpen);

    const updateCoords = React.useCallback(() => {
        if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setCoords({
                left: rect.left + rect.width / 2,
                bottom: window.innerHeight - rect.top + 10,
            });
        }
    }, []);

    const openVolumePanel = React.useCallback(() => {
        if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
        updateCoords();
        setIsVolumePanelOpen(true);
    }, [updateCoords]);

    const scheduleCloseVolumePanel = React.useCallback((delay = 2800) => {
        if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
        volumeTimerRef.current = setTimeout(() => {
            if (draggingRef.current || panelRef.current?.contains(document.activeElement)
                || buttonRef.current === document.activeElement) return;
            setIsVolumePanelOpen(false);
        }, delay);
    }, []);

    const cancelCloseVolumePanel = React.useCallback(() => {
        if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
    }, []);

    React.useEffect(() => {
        return () => {
            if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
        };
    }, []);

    const handleVolumeChange = (e) => {
        const newVol = parseFloat(e.target.value);
        setVolume(newVol);
        if (audioRef?.current) audioRef.current.volume = newVol;
        setIsMuted(newVol === 0);
        openVolumePanel();
    };

    const handleButtonClick = (e) => {
        e.stopPropagation();
        if (!isVolumePanelOpen) {
            // 第一次点击/触屏点按：向上弹出音量控制条，不触发静音
            openVolumePanel();
            scheduleCloseVolumePanel(3500);
            return;
        }
        // 已弹出状态下再次点击：切换静音与解除静音
        if (isMuted || volume === 0) {
            const restored = prevVolume || 0.8;
            setVolume(restored);
            if (audioRef?.current) audioRef.current.volume = restored;
            setIsMuted(false);
        } else {
            setPrevVolume(volume);
            setVolume(0);
            if (audioRef?.current) audioRef.current.volume = 0;
            setIsMuted(true);
        }
        openVolumePanel();
        scheduleCloseVolumePanel(3000);
    };

    const handleWheel = (e) => {
        e.stopPropagation();
        const delta = e.deltaY < 0 ? 0.05 : -0.05;
        let newVol = volume + delta;
        newVol = Math.max(0, Math.min(1, newVol));
        setVolume(newVol);
        if (audioRef?.current) audioRef.current.volume = newVol;
        setIsMuted(newVol === 0);
        openVolumePanel();
        scheduleCloseVolumePanel(3000);
    };

    return (
        <div 
            data-player-interaction={isExpanded ? 'controls' : undefined}
            className={`relative flex items-center justify-center ${isExpanded ? 'text-white/70 hover:text-white' : ''}`}
            onMouseEnter={openVolumePanel}
            onMouseLeave={() => scheduleCloseVolumePanel(1200)}
            onWheel={handleWheel}
            onFocusCapture={(event) => {
                if (event.target.matches?.(':focus-visible')) openVolumePanel();
            }}
            onBlurCapture={(event) => {
                if (!panelRef.current?.contains(event.relatedTarget)) scheduleCloseVolumePanel(1200);
            }}
        >
            <button 
                ref={buttonRef}
                onClick={handleButtonClick} 
                aria-label={isMuted || volume === 0 ? t("取消静音") : t("静音")}
                className={isExpanded
                    ? 'transition-all hover:scale-110 active:scale-95 outline-none p-1 flex items-center justify-center cursor-pointer'
                    : 'player-console__icon p-1.5 transition-all duration-300 active:scale-90 text-[var(--muted)] hover:text-[var(--ink)]'
                }
                title={isVolumePanelOpen ? (volume === 0 ? t("点击恢复音量") : t("点击静音")) : t("当前音量 {p0}%（点击或悬停展开）", { p0: (Math.round(volume * 100)) })}
            >
                {isMuted || volume === 0 ? <VolumeX size={isExpanded ? 18 : 20} /> : <Volume2 size={isExpanded ? 18 : 20} />}
            </button>

            {/* 通过 Portal 渲染到 body，彻底摆脱父级 overflow-hidden 裁切 */}
            {typeof document !== 'undefined' && createPortal(
                <div 
                    ref={panelRef}
                    data-player-interaction={isExpanded ? 'controls' : undefined}
                    aria-hidden={!isVolumePanelOpen || undefined}
                    inert={!isVolumePanelOpen ? '' : undefined}
                    className={`fixed -translate-x-1/2 flex flex-col items-center pointer-events-none transition-all duration-200 z-[99999] select-none ${
                        isVolumePanelOpen ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 translate-y-2 scale-95 pointer-events-none'
                    }`}
                    style={{
                        left: `${coords.left}px`,
                        bottom: `${coords.bottom}px`,
                    }}
                    onMouseEnter={cancelCloseVolumePanel}
                    onMouseLeave={() => scheduleCloseVolumePanel(1200)}
                    onClick={(e) => e.stopPropagation()}
                    onFocusCapture={cancelCloseVolumePanel}
                    onBlurCapture={(event) => {
                        if (!panelRef.current?.contains(event.relatedTarget)) scheduleCloseVolumePanel(1200);
                    }}
                >
                    <div 
                        className={`player-volume-panel w-9 h-[112px] py-2.5 rounded-full flex flex-col items-center select-none relative ${
                            isExpanded
                                ? 'bg-black/80 backdrop-blur-2xl text-white shadow-[0_12px_32px_rgba(0,0,0,0.6)] border border-white/15'
                                : 'bg-white/90 dark:bg-slate-900/90 backdrop-blur-2xl text-[var(--ink)] shadow-[0_16px_36px_rgba(0,0,0,0.3)] border border-black/10 dark:border-white/15'
                        }`}
                    >
                        <span className={`text-[10px] font-mono font-bold select-none tracking-tight w-full text-center pb-2 ${
                            isExpanded ? 'text-white/80' : 'text-[var(--ink)]'
                        }`}>
                            {Math.round(volume * 100)}
                        </span>
                        <div className={`w-1.5 h-16 rounded-full overflow-hidden flex flex-col-reverse relative pointer-events-none ${
                            isExpanded ? 'bg-white/20' : 'bg-black/10 dark:bg-white/15'
                        }`}>
                            <div 
                                className={`w-full rounded-full transition-all duration-75 shadow-sm ${
                                    isExpanded ? 'bg-white shadow-[0_0_8px_rgba(255,255,255,0.4)]' : 'bg-[var(--accent)]'
                                }`}
                                style={{ height: `${Math.round(volume * 100)}%` }}
                            />
                        </div>
                        {/* 隐形垂直滑块 */}
                        <input
                            type="range"
                            min="0" max="1" step="0.01"
                            value={volume}
                            onPointerDown={(event) => {
                                draggingRef.current = true;
                                event.currentTarget.setPointerCapture?.(event.pointerId);
                                cancelCloseVolumePanel();
                            }}
                            onPointerUp={() => { draggingRef.current = false; scheduleCloseVolumePanel(2500); }}
                            onPointerCancel={() => { draggingRef.current = false; scheduleCloseVolumePanel(2500); }}
                            onTouchStart={cancelCloseVolumePanel}
                            onTouchEnd={() => scheduleCloseVolumePanel(2500)}
                            onChange={handleVolumeChange}
                            aria-label={t("音量")}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                            style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                        />
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
