import React from 'react';
import { Activity, ChevronDown, Pin, PinOff } from 'lucide-react';

export default function ImmersiveChrome({
    isVisible,
    controlsPinned,
    ambientEnabled,
    ambientIntensity,
    onClose,
    onReveal,
    onControlsPinnedChange,
    onAmbientEnabledChange,
    onAmbientIntensityChange,
    modeSwitcher = null,
    toolEntry = null,
}) {
    const cycleAmbient = () => {
        if (!ambientEnabled) {
            onAmbientEnabledChange(true);
            onAmbientIntensityChange('subtle');
            return;
        }
        if (ambientIntensity === 'subtle') {
            onAmbientIntensityChange('standard');
            return;
        }
        if (ambientIntensity === 'standard') {
            onAmbientIntensityChange('intense');
            return;
        }
        onAmbientEnabledChange(false);
    };

    const ambientTitle = !ambientEnabled
        ? '开启音乐呼吸'
        : ambientIntensity === 'intense'
            ? '音乐呼吸：强劲'
            : ambientIntensity === 'standard'
                ? '音乐呼吸：标准'
                : '音乐呼吸：轻';

    return (
        <div className={`absolute left-8 right-8 top-6 z-30 flex items-center justify-between transition-all duration-500 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3 pointer-events-none'}`}>
            <div className="flex items-center gap-2">
                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        onClose();
                    }}
                    className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 text-white/85 backdrop-blur-md transition hover:bg-white/15 hover:text-white focus:outline-none"
                    title="退出全屏"
                >
                    <ChevronDown size={28} />
                </button>

                <div onClick={(event) => event.stopPropagation()}>
                    {modeSwitcher}
                </div>
            </div>

            <div className="flex items-center gap-2">
                {toolEntry && (
                    <div onClick={(event) => event.stopPropagation()}>
                        {toolEntry}
                    </div>
                )}
                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        onControlsPinnedChange(!controlsPinned);
                        onReveal();
                    }}
                    className={`flex h-11 w-11 items-center justify-center rounded-full backdrop-blur-md transition focus:outline-none ${controlsPinned ? 'bg-white/18 text-white' : 'bg-black/30 text-white/75 hover:bg-white/15 hover:text-white'}`}
                    title={controlsPinned ? '控制栏保持显示' : '控制栏自动隐退'}
                    aria-pressed={controlsPinned}
                >
                    {controlsPinned ? <Pin size={18} /> : <PinOff size={18} />}
                </button>

                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        cycleAmbient();
                        onReveal();
                    }}
                    className={`flex h-11 w-11 items-center justify-center rounded-full backdrop-blur-md transition focus:outline-none ${ambientEnabled ? 'bg-white/18 text-white' : 'bg-black/30 text-white/75 hover:bg-white/15 hover:text-white'}`}
                    title={ambientTitle}
                    aria-pressed={ambientEnabled}
                >
                    <Activity size={18} className={ambientEnabled && ambientIntensity !== 'subtle' ? 'scale-110' : ''} />
                </button>

            </div>
        </div>
    );
}
