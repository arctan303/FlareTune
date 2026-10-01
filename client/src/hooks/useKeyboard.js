import { t } from '../i18n/index.js';
import { useEffect } from 'react';
import { isInteractiveKeyboardTarget } from '../utils/keyboardActivation.js';

export function useGlobalKeyboardShortcuts({ togglePlay, isPlaying, playPrev, playNext, volume, setVolume, showToast, onOpenSearch }) {
    useEffect(() => {
        const handleKeyDown = (e) => {
            const isTyping = Boolean(e.target?.closest?.('input, textarea, [contenteditable="true"], [role="slider"]'));
            const isInteractive = isInteractiveKeyboardTarget(e.target);

            // Ctrl+K / Cmd+K 全局呼出搜索
            if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                onOpenSearch?.();
                return;
            }

            // '/' 键快捷唤起搜索（当非输入状态时）
            if (e.key === '/' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !isTyping) {
                if (!isInteractive) {
                    e.preventDefault();
                    onOpenSearch?.();
                    return;
                }
            }

            if (isTyping || isInteractive) return;
            if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    togglePlay();
                    showToast(!isPlaying ? '▶ 继续播放' : '⏸ 已暂停', 1500);
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    playPrev();
                    showToast(t("⏮ 上一首"), 1500);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    playNext();
                    showToast(t("⏭ 下一首"), 1500);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    const vUp = Math.min(1, Math.round((volume + 0.1) * 10) / 10);
                    setVolume(vUp);
                    showToast(t("🔊 音量: {p0}%", { p0: (Math.round(vUp * 100)) }), 1500);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    const vDown = Math.max(0, Math.round((volume - 0.1) * 10) / 10);
                    setVolume(vDown);
                    showToast(t("🔉 音量: {p0}%", { p0: (Math.round(vDown * 100)) }), 1500);
                    break;
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [togglePlay, playPrev, playNext, volume, setVolume, isPlaying, showToast, onOpenSearch]);
}
