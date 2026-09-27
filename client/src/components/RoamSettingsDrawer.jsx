import React, { useState, useEffect, useRef } from 'react';
import { X, SlidersHorizontal, Compass, Check, RotateCcw } from 'lucide-react';
import { useUIStore, showToast } from '../store/useUIStore';
import { usePlayerStore } from '../store/usePlayerStore';
import DrawerFrame from './drawers/DrawerFrame';
import { useDrawerTransition } from './drawers/useDrawerTransition';

export const ROAM_LANGUAGES = [
    { key: 'zh', label: '华语' },
    { key: 'en', label: '欧美' },
    { key: 'ja', label: '日语' },
    { key: 'ko', label: '韩语' },
    { key: 'instrumental', label: '纯音乐' },
    { key: 'other', label: '其他' },
];

export const ROAM_BATCH_SIZE_OPTIONS = [5, 10, 15, 20];

const ALL_KEYS = ROAM_LANGUAGES.map((item) => item.key);

export default function RoamSettingsDrawer() {
    const isRoamSettingsOpen = useUIStore((s) => s.isRoamSettingsOpen);
    const setIsRoamSettingsOpen = useUIStore((s) => s.setIsRoamSettingsOpen);
    const isFullScreen = useUIStore((s) => s.isFullScreen);

    const randomRoam = usePlayerStore((s) => s.randomRoam);
    const setRandomRoamLanguage = usePlayerStore((s) => s.setRandomRoamLanguage);
    const setRandomRoamBatchSize = usePlayerStore((s) => s.setRandomRoamBatchSize);
    const setRandomRoamEnabled = usePlayerStore((s) => s.setRandomRoamEnabled);
    const resetRandomRoamHistory = usePlayerStore((s) => s.resetRandomRoamHistory);

    const { mounted, visible, onPanelTransitionEnd } = useDrawerTransition(isRoamSettingsOpen);
    const closeButtonRef = useRef(null);
    const previousFocusRef = useRef(null);

    // 语种多选本地临时状态
    const [selectedKeys, setSelectedKeys] = useState(() => {
        const lang = randomRoam?.language || 'all';
        if (lang === 'all') return ALL_KEYS;
        const list = lang.split(',').map((k) => k.trim()).filter(Boolean);
        return list.length ? list : ALL_KEYS;
    });

    // 单次补充数量本地状态
    const [selectedBatchSize, setSelectedBatchSize] = useState(() => {
        return randomRoam?.batchSize || 10;
    });

    // 当抽屉打开时同步当前 Store 偏好
    useEffect(() => {
        if (isRoamSettingsOpen) {
            setSelectedBatchSize(randomRoam?.batchSize || 10);
            const lang = randomRoam?.language || 'all';
            if (lang === 'all') {
                setSelectedKeys(ALL_KEYS);
            } else {
                const list = lang.split(',').map((k) => k.trim()).filter((k) => ALL_KEYS.includes(k));
                setSelectedKeys(list.length ? list : ALL_KEYS);
            }
        }
    }, [isRoamSettingsOpen, randomRoam?.language, randomRoam?.batchSize]);

    // 焦点管理与无障碍
    useEffect(() => {
        if (isRoamSettingsOpen && mounted) {
            previousFocusRef.current = document.activeElement;
            requestAnimationFrame(() => closeButtonRef.current?.focus());
        } else if (!isRoamSettingsOpen && previousFocusRef.current instanceof HTMLElement) {
            previousFocusRef.current.focus();
            previousFocusRef.current = null;
        }
    }, [isRoamSettingsOpen, mounted]);

    // Escape 键关闭
    useEffect(() => {
        if (!isRoamSettingsOpen) return undefined;
        const handleEscape = (event) => {
            if (event.key === 'Escape') setIsRoamSettingsOpen(false);
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [isRoamSettingsOpen, setIsRoamSettingsOpen]);

    if (!mounted) return null;

    const handleClose = () => setIsRoamSettingsOpen(false);

    const isAllSelected = selectedKeys.length === ALL_KEYS.length;

    const handleToggleKey = (key) => {
        setSelectedKeys((prev) => {
            if (prev.includes(key)) {
                return prev.filter((k) => k !== key);
            }
            return [...prev, key];
        });
    };

    const handleToggleSelectAll = () => {
        if (isAllSelected) {
            setSelectedKeys([]);
        } else {
            setSelectedKeys(ALL_KEYS);
        }
    };

    const handleClearSelection = () => {
        // 快捷选项：仅华语
        setSelectedKeys(['zh']);
    };

    const handleSave = (enableRoam = false) => {
        if (selectedKeys.length === 0) {
            showToast('请至少选择一个语种范围', 2000);
            return;
        }

        let finalLang = 'all';
        if (!isAllSelected && selectedKeys.length > 0) {
            const sortedKeys = ALL_KEYS.filter((k) => selectedKeys.includes(k));
            finalLang = sortedKeys.join(',');
        }
        const langChanged = randomRoam?.language !== finalLang;
        setRandomRoamLanguage(finalLang);
        setRandomRoamBatchSize(selectedBatchSize);

        if (enableRoam && !randomRoam.enabled) {
            const success = setRandomRoamEnabled(true, { language: finalLang });
            if (success) {
                showToast('漫游偏好已保存并开启漫游', 2000);
            } else {
                showToast('漫游偏好已保存，播放列表中有歌曲即可开启漫游', 2500);
            }
        } else if (randomRoam.enabled && langChanged) {
            showToast('漫游偏好已保存，已即时更新后续曲目', 2000);
        } else {
            showToast('漫游偏好设置已保存', 2000);
        }
        handleClose();
    };

    const handleResetHistory = () => {
        resetRandomRoamHistory();
        showToast('已重置漫游去重记录，歌曲可再次被推荐', 2000);
    };

    const seenCount = randomRoam?.seenSongIds?.length || 0;

    return (
        <DrawerFrame
            visible={visible}
            isFullScreen={isFullScreen}
            labelledBy="roam-settings-drawer-title"
            onClose={handleClose}
            onPanelTransitionEnd={onPanelTransitionEnd}
            panelClassName="roam-settings-drawer sm:w-[440px] overflow-y-auto"
        >
            {/* 头部 */}
            <div className="theme-drawer__header sticky top-0 z-10 flex items-center justify-between px-6 py-5 border-b border-[var(--line)] bg-[var(--surface)]">
                <h2 id="roam-settings-drawer-title" className="theme-drawer__title text-lg font-semibold flex items-center gap-2.5 text-[var(--ink)]">
                    <SlidersHorizontal size={20} className="text-[var(--accent)]" />
                    <span>漫游偏好设置</span>
                </h2>
                <button
                    ref={closeButtonRef}
                    aria-label="关闭漫游偏好设置"
                    onClick={handleClose}
                    className="theme-drawer__close flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)] p-1 rounded-full transition-colors"
                >
                    <X size={18} strokeWidth={2} />
                </button>
            </div>

            {/* 抽屉正文 */}
            <div className="p-6 space-y-6 flex-1 text-sm">
                {/* 区域 1：当前状态 */}
                <div className="flex items-center justify-between p-3.5 rounded-xl bg-current/5 border border-current/10">
                    <div className="flex items-center gap-2.5">
                        <Compass size={16} className={randomRoam.enabled ? 'text-[var(--accent)]' : 'text-[var(--muted)]'} />
                        <span className="text-xs font-semibold text-[var(--ink)]">随机漫游</span>
                        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                            randomRoam.enabled
                                ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                                : 'bg-current/10 text-[var(--muted)]'
                        }`}>
                            {randomRoam.enabled ? '已开启' : '已暂停'}
                        </span>
                    </div>
                    <span className="text-xs text-[var(--muted)]">
                        {randomRoam.enabled ? '队尾自动续播' : '播完停止'}
                    </span>
                </div>

                {/* 区域 2：语种多选范围 */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="font-semibold text-xs text-[var(--ink)]">语种范围</h3>
                            <p className="text-[11px] text-[var(--muted)] mt-0.5">
                                {isAllSelected ? '已选全部' : (selectedKeys.length === 0 ? '未选择（请至少选一项）' : `已选 ${selectedKeys.length} 项`)}
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleToggleSelectAll}
                                className={`text-xs px-2.5 py-1 rounded-full border transition-all cursor-pointer ${
                                    isAllSelected
                                        ? 'border-[var(--accent)] text-[var(--accent)] font-semibold bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]'
                                        : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--fill)]'
                                }`}
                            >
                                {isAllSelected ? '全不选' : '全选'}
                            </button>
                            <button
                                type="button"
                                onClick={handleClearSelection}
                                className="text-xs px-2.5 py-1 rounded-full border border-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--fill)] transition-all cursor-pointer"
                            >
                                仅华语
                            </button>
                        </div>
                    </div>

                    {/* 语种网格列表（紧凑无废话） */}
                    <div className="grid grid-cols-3 gap-2 pt-1">
                        {ROAM_LANGUAGES.map((item) => {
                            const isSelected = selectedKeys.includes(item.key);
                            return (
                                <button
                                    key={item.key}
                                    type="button"
                                    onClick={() => handleToggleKey(item.key)}
                                    className={`flex items-center justify-between py-2.5 px-3 rounded-xl border text-xs font-medium transition-all duration-150 cursor-pointer ${
                                        isSelected
                                            ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface-raised))] text-[var(--accent)] font-semibold shadow-2xs'
                                            : 'border-current/10 bg-current/5 text-[var(--muted)] hover:text-[var(--ink)] hover:border-current/20'
                                    }`}
                                >
                                    <span>{item.label}</span>
                                    <div className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 border transition-all ${
                                        isSelected
                                            ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                                            : 'border-current/20 text-transparent'
                                    }`}>
                                        <Check size={10} strokeWidth={3} />
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* 区域 3：单次补充数量 */}
                <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-xs text-[var(--ink)]">单次补充数量</h3>
                        <span className="text-[11px] text-[var(--muted)] font-mono">
                            每次自动补充 {selectedBatchSize} 首
                        </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                        {ROAM_BATCH_SIZE_OPTIONS.map((count) => {
                            const isSelected = selectedBatchSize === count;
                            return (
                                <button
                                    key={count}
                                    type="button"
                                    onClick={() => setSelectedBatchSize(count)}
                                    className={`flex items-center justify-center py-2 px-2.5 rounded-xl border text-xs font-medium transition-all duration-150 cursor-pointer ${
                                        isSelected
                                            ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface-raised))] text-[var(--accent)] font-semibold shadow-2xs'
                                            : 'border-current/10 bg-current/5 text-[var(--muted)] hover:text-[var(--ink)] hover:border-current/20'
                                    }`}
                                >
                                    <span>{count} 首{count === 10 ? ' (默认)' : ''}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* 区域 4：去重记录管理 */}
                <div className="flex items-center justify-between px-1 text-xs text-[var(--muted)]">
                    <span>已去重：{seenCount} 首</span>
                    {seenCount > 0 && (
                        <button
                            type="button"
                            onClick={handleResetHistory}
                            className="text-button text-xs flex items-center gap-1 text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer"
                            title="清空去重历史"
                        >
                            <RotateCcw size={12} />
                            <span>重置</span>
                        </button>
                    )}
                </div>
            </div>

            {/* 底部按钮栏 */}
            <div className="sticky bottom-0 z-10 p-5 border-t border-[var(--line)] bg-[var(--surface)] flex items-center gap-3">
                <button
                    type="button"
                    onClick={() => handleSave(false)}
                    className="flex-1 py-2.5 px-4 rounded-xl text-xs font-semibold border border-[var(--line)] text-[var(--ink)] hover:bg-[var(--fill)] transition-colors"
                >
                    保存偏好
                </button>
                {!randomRoam.enabled && (
                    <button
                        type="button"
                        onClick={() => handleSave(true)}
                        className="flex-1 primary-button py-2.5 px-4 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 shadow-sm"
                    >
                        <Compass size={14} />
                        <span>保存并开启漫游</span>
                    </button>
                )}
            </div>
        </DrawerFrame>
    );
}
