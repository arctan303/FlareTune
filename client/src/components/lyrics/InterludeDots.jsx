import React from 'react';

/**
 * 间奏三点进度指示器（沉稳同步呼吸与冲线里程碑模型）
 *
 * 视觉与时序：
 * - stage 0: ○ ○ ○ 全暗态（刚进入间奏等待起跑）
 * - stage 1: ● ○ ○ 满 1/3 进度，第 1 颗点亮发光
 * - stage 2: ● ● ○ 满 2/3 进度，第 2 颗点亮发光
 * - stage 3: ● ● ● 100% 冲线达成，三颗全亮！随即优雅融出并交接回原歌词换行
 */
export default function InterludeDots({
    stage = 0,
    dotTimes = null,
    onSeekDot = null,
    className = '',
}) {
    const isStage1 = stage >= 1;
    const isStage2 = stage >= 2;
    const isStage3 = stage >= 3;

    const handleDotClick = (dotIndex, time, e) => {
        e?.stopPropagation?.();
        e?.preventDefault?.();
        if (typeof onSeekDot === 'function' && Number.isFinite(time)) {
            onSeekDot(time, dotIndex);
        }
    };

    const isClickable = typeof onSeekDot === 'function' && Boolean(dotTimes);

    return (
        <div
            className={`classic-lyrics__interlude-dots flex items-center justify-start gap-1 select-none py-1 animate-[pulse_2.4s_ease-in-out_infinite] ${className}`}
            aria-label={`间奏进度第 ${stage} 阶段`}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
        >
            {/* 气泡 1 */}
            <button
                type="button"
                aria-label="跳转到间奏第 1 阶段（1/3 进度）"
                onClick={(e) => handleDotClick(1, dotTimes?.t1, e)}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="group/dot relative p-2 md:p-2.5 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 rounded-full cursor-pointer"
            >
                <span
                    className={`block w-4 h-4 md:w-4.5 md:h-4.5 rounded-full transition-all duration-400 cubic-bezier(0.34, 1.56, 0.64, 1) group-hover/dot:scale-125 group-active/dot:scale-95 ${
                        isStage1
                            ? 'bg-white scale-100 opacity-100 shadow-[0_0_12px_rgba(255,255,255,0.85)]'
                            : 'bg-white/20 scale-85 opacity-35 group-hover/dot:bg-white/40 group-hover/dot:opacity-60'
                    }`}
                />
            </button>

            {/* 气泡 2 */}
            <button
                type="button"
                aria-label="跳转到间奏第 2 阶段（2/3 进度）"
                onClick={(e) => handleDotClick(2, dotTimes?.t2, e)}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="group/dot relative p-2 md:p-2.5 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 rounded-full cursor-pointer"
            >
                <span
                    className={`block w-4 h-4 md:w-4.5 md:h-4.5 rounded-full transition-all duration-400 cubic-bezier(0.34, 1.56, 0.64, 1) group-hover/dot:scale-125 group-active/dot:scale-95 ${
                        isStage2
                            ? 'bg-white scale-100 opacity-100 shadow-[0_0_12px_rgba(255,255,255,0.85)]'
                            : 'bg-white/20 scale-85 opacity-35 group-hover/dot:bg-white/40 group-hover/dot:opacity-60'
                    }`}
                />
            </button>

            {/* 气泡 3 */}
            <button
                type="button"
                aria-label="跳转到间奏冲线阶段（100% 达成）"
                onClick={(e) => handleDotClick(3, dotTimes?.t3, e)}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="group/dot relative p-2 md:p-2.5 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 rounded-full cursor-pointer"
            >
                <span
                    className={`block w-4 h-4 md:w-4.5 md:h-4.5 rounded-full transition-all duration-400 cubic-bezier(0.34, 1.56, 0.64, 1) group-hover/dot:scale-125 group-active/dot:scale-95 ${
                        isStage3
                            ? 'bg-white scale-100 opacity-100 shadow-[0_0_14px_rgba(255,255,255,0.95)]'
                            : 'bg-white/20 scale-85 opacity-35 group-hover/dot:bg-white/40 group-hover/dot:opacity-60'
                    }`}
                />
            </button>
        </div>
    );
}
