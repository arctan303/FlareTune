import React from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useShallow } from 'zustand/react/shallow';
import PlaybackModeIcon from './PlaybackModeIcon.jsx';

export default function PlayModeToggle({ isExpanded }) {
    const { playMode, handleModeChange } = usePlayerStore(useShallow((state) => ({
        playMode: state.playMode,
        handleModeChange: state.handleModeChange,
    })));
    const [animatePop, setAnimatePop] = React.useState(false);

    const modeNameMap = {
        'single': '单曲循环',
        'random': '随机播放',
        'sequence': '顺序播放',
        'loop': '列表循环'
    };

    const handleClick = () => {
        setAnimatePop(true);
        handleModeChange();
    };

    return (
        <button 
            type="button"
            onClick={handleClick} 
            aria-label={`切换播放模式，当前为${modeNameMap[playMode] || '未知'}`}
            className={`transition-all active:scale-90 outline-none flex items-center justify-center ${
                isExpanded 
                    ? 'text-white/70 hover:text-white hover:scale-110' 
                    : 'player-console__icon'
            }`}
            title={`当前模式: ${modeNameMap[playMode] || '未知'}`}
        >
            <span
                key={playMode}
                className={animatePop ? 'animate-icon-pop flex items-center justify-center' : 'flex items-center justify-center'}
                onAnimationEnd={() => setAnimatePop(false)}
            >
                <PlaybackModeIcon mode={playMode} size={isExpanded ? 18 : 20} />
            </span>
        </button>
    );
}
