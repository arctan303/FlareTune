import { t } from '../i18n/index.js';
import React from 'react';
import { BookOpen, RefreshCw, X } from 'lucide-react';
import { useUIStore } from '../store/useUIStore.js';
import PageBackButton from './PageBackButton.jsx';

export const cleanPlaylistDescription = (value) => value
    ? value.replace(/\\r\\n|\\n|\\r/g, '\n')
    : '';

export function PlaylistDescriptionDrawer({ playlist, info, isOpen, onClose }) {
    const isFullScreen = useUIStore((state) => state.isFullScreen);
    const [mounted, setMounted] = React.useState(false);
    const [isClosing, setIsClosing] = React.useState(false);
    const closeButtonRef = React.useRef(null);

    React.useEffect(() => {
        if (isOpen) {
            setMounted(true);
            setIsClosing(false);
        } else if (mounted) {
            setIsClosing(true);
            const timer = setTimeout(() => setMounted(false), 300);
            return () => clearTimeout(timer);
        }
        return undefined;
    }, [isOpen, mounted]);

    React.useEffect(() => {
        if (isOpen && mounted) requestAnimationFrame(() => closeButtonRef.current?.focus());
    }, [isOpen, mounted]);

    React.useEffect(() => {
        if (!isOpen) return undefined;
        const handleEscape = (event) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [isOpen, onClose]);

    if (!mounted) return null;
    return (
        <div role="dialog" aria-modal="true" aria-labelledby="playlist-desc-drawer-title" className={`fixed inset-0 z-[100] flex justify-end ${isFullScreen ? 'dark' : ''}`}>
            <div className={`absolute inset-0 transition-opacity duration-300 ${isClosing ? 'opacity-0' : 'opacity-100'} drawer-backdrop`} onClick={onClose} />
            <div className={`theme-drawer w-full sm:w-[440px] h-full relative z-10 flex flex-col ${isClosing ? 'animate-[slide-out-right_0.3s_ease-in]' : 'animate-[slide-in-right_0.3s_ease-out]'} overflow-y-auto`}>
                <div className="theme-drawer__header sticky top-0 z-10 flex items-center justify-between px-6 py-5">
                    <h2 id="playlist-desc-drawer-title" className="theme-drawer__title text-lg font-semibold flex items-center gap-2">
                        <BookOpen size={20} strokeWidth={1.8} />{t("歌单简介")}</h2>
                    <button ref={closeButtonRef} aria-label={t("关闭歌单简介")} onClick={onClose} className="theme-drawer__close flex items-center justify-center">
                        <X size={16} strokeWidth={2} />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-5">
                    <p className="theme-drawer__meta text-xs uppercase tracking-wider mb-1">{playlist?.type === 'liked' ? t("私人精选") : t("歌单详情")}</p>
                    <h3 className="theme-drawer__title text-xl font-bold mb-2">{playlist?.kind === 'favorite' ? t("我的收藏") : playlist?.name}</h3>
                    {info?.creator && <p className="theme-drawer__meta text-xs mb-5">{t("创建者：")}{info.creator} {info?.createdAt ? ` • ${info.createdAt}` : ''}</p>}
                    <div className="theme-drawer__body text-sm space-y-3 leading-relaxed whitespace-pre-line border-t border-[var(--soft-line)] pt-4">
                        {cleanPlaylistDescription(info?.description) || t("暂无详细介绍。")}
                    </div>
                </div>
            </div>
        </div>
    );
}

export function PendingPlaylistDetail({ loadState, onClose, onRetry, headingRef }) {
    if (!['skeleton', 'error'].includes(loadState.status)) return null;
    return (
        <div className="playlist-detail playlist-detail--pending w-full animate-[fade-in_0.2s_ease-out]">
            <div className="mb-10">
                <PageBackButton onClick={onClose} className="mb-6" />
                {loadState.status === 'error' ? (
                    <section className="playlist-load-error state-panel state-panel--error" aria-labelledby="playlist-load-error-title">
                        <p className="state-panel__eyebrow">PLAYLIST INTERRUPTED</p>
                        <h2 ref={headingRef} id="playlist-load-error-title" tabIndex={-1}>{t("歌单暂时无法打开")}</h2>
                        <p className="state-panel__copy">{t(loadState.error?.message || '请求没有完成，请稍后重试。')}</p>
                        <button type="button" className="primary-button mt-5 inline-flex min-h-11 items-center gap-2 px-5" onClick={() => onRetry(loadState.playlist)}>
                            <RefreshCw size={17} aria-hidden="true" />{t("重新加载")}</button>
                    </section>
                ) : (
                    <section className="playlist-loading-shell" aria-labelledby="playlist-loading-title" aria-busy="true">
                        <div className="playlist-loading-shell__masthead">
                            <div className="image-loading-placeholder playlist-loading-shell__cover" aria-hidden="true" />
                            <div className="playlist-loading-shell__copy">
                                <p className="playlist-eyebrow">{t("正在打开")}</p>
                                <h2 ref={headingRef} id="playlist-loading-title" tabIndex={-1} className="line-clamp-2">{loadState.playlist?.kind === 'favorite' ? t("我的收藏") : (loadState.playlist?.name || t("歌单"))}</h2>
                                <div className="loading-line w-3/4" aria-hidden="true" />
                                <div className="loading-line w-1/2" aria-hidden="true" />
                            </div>
                        </div>
                        <div className="playlist-loading-shell__tracks" aria-hidden="true">
                            {Array.from({ length: 6 }, (_, index) => (
                                <div key={index} className="playlist-loading-row">
                                    <span className="loading-block" /><span className="loading-line" /><span className="loading-line loading-line--short" />
                                </div>
                            ))}
                        </div>
                        <span className="sr-only" role="status">{t("正在加载歌单详情")}</span>
                    </section>
                )}
            </div>
        </div>
    );
}
