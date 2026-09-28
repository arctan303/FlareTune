import { t } from '../i18n/index.js';
import React from 'react';
import {
  X,
  Image as ImageIcon,
  Check,
  RotateCcw,
  Sliders,
  Sparkles,
  Link2,
  Upload,
  Trash2,
  Droplet,
  Sun,
  Layers,
} from 'lucide-react';
import { useUIStore, showToast } from '../store/useUIStore';
import { useWallpaperStore } from '../store/useWallpaperStore';
import {
  WALLPAPER_PRESETS,
  WALLPAPER_LIMITS,
  CARD_GLASS_LIMITS,
  CARD_GLASS_PRESETS,
} from '../constants/wallpaperPresets';
import DrawerFrame from './drawers/DrawerFrame';
import { useDrawerTransition } from './drawers/useDrawerTransition';

export default function BackgroundDrawer() {
  const isBackgroundDrawerOpen = useUIStore((s) => s.isBackgroundDrawerOpen);
  const setIsBackgroundDrawerOpen = useUIStore((s) => s.setIsBackgroundDrawerOpen);
  const isFullScreen = useUIStore((s) => s.isFullScreen);

  const enabled = useWallpaperStore((s) => s.enabled);
  const toggleEnabled = useWallpaperStore((s) => s.toggleEnabled);
  const activeSource = useWallpaperStore((s) => s.activeSource);
  const activePresetId = useWallpaperStore((s) => s.activePresetId);
  const customUrl = useWallpaperStore((s) => s.customUrl);
  const hasLocalImage = useWallpaperStore((s) => s.hasLocalImage);
  const localImageName = useWallpaperStore((s) => s.localImageName);
  const localImageUrl = useWallpaperStore((s) => s.localImageUrl);
  const localImagePersistence = useWallpaperStore((s) => s.localImagePersistence);
  const imageStatus = useWallpaperStore((s) => s.imageStatus);
  const setPreset = useWallpaperStore((s) => s.setPreset);
  const setCustomUrl = useWallpaperStore((s) => s.setCustomUrl);
  const setLocalImage = useWallpaperStore((s) => s.setLocalImage);
  const removeLocalImage = useWallpaperStore((s) => s.removeLocalImage);
  const setActiveSource = useWallpaperStore((s) => s.setActiveSource);
  const blur = useWallpaperStore((s) => s.blur);
  const setBlur = useWallpaperStore((s) => s.setBlur);
  const opacity = useWallpaperStore((s) => s.opacity);
  const setOpacity = useWallpaperStore((s) => s.setOpacity);
  const brightness = useWallpaperStore((s) => s.brightness);
  const setBrightness = useWallpaperStore((s) => s.setBrightness);
  const resetDefaults = useWallpaperStore((s) => s.resetDefaults);
  const cardBlur = useWallpaperStore((s) => s.cardBlur);
  const setCardBlur = useWallpaperStore((s) => s.setCardBlur);
  const cardSaturate = useWallpaperStore((s) => s.cardSaturate);
  const setCardSaturate = useWallpaperStore((s) => s.setCardSaturate);
  const cardOpacity = useWallpaperStore((s) => s.cardOpacity);
  const setCardOpacity = useWallpaperStore((s) => s.setCardOpacity);
  const setCardGlassPreset = useWallpaperStore((s) => s.setCardGlassPreset);
  const resetCardGlassDefaults = useWallpaperStore((s) => s.resetCardGlassDefaults);

  const [customInput, setCustomInput] = React.useState(customUrl || '');
  const [isProcessingFile, setIsProcessingFile] = React.useState(false);
  const fileInputRef = React.useRef(null);

  React.useEffect(() => {
    setCustomInput(customUrl || '');
  }, [customUrl]);

  const { mounted, visible, onPanelTransitionEnd } = useDrawerTransition(isBackgroundDrawerOpen);
  const closeButtonRef = React.useRef(null);
  const previousFocusRef = React.useRef(null);

  React.useEffect(() => {
    if (isBackgroundDrawerOpen && mounted) {
      previousFocusRef.current = document.activeElement;
      requestAnimationFrame(() => closeButtonRef.current?.focus());
    } else if (!isBackgroundDrawerOpen && mounted) {
      if (previousFocusRef.current instanceof HTMLElement && previousFocusRef.current.isConnected) {
        previousFocusRef.current.focus();
      }
      previousFocusRef.current = null;
    }
  }, [isBackgroundDrawerOpen, mounted]);

  React.useEffect(() => {
    if (!isBackgroundDrawerOpen) return undefined;
    const handleEscape = (event) => {
      if (event.key === 'Escape') setIsBackgroundDrawerOpen(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isBackgroundDrawerOpen, setIsBackgroundDrawerOpen]);

  if (!mounted) return null;

  const handleClose = () => setIsBackgroundDrawerOpen(false);

  const handleSelectPreset = (presetId) => {
    setPreset(presetId, true);
  };

  const handleResetDefaults = () => {
    const activePreset = WALLPAPER_PRESETS.find((p) => p.id === activePresetId) || WALLPAPER_PRESETS[0];
    if (activePreset) {
      setBlur(activePreset.defaultBlur);
      setOpacity(activePreset.defaultOpacity);
      setBrightness(activePreset.defaultBrightness ?? WALLPAPER_LIMITS.brightness.default);
      setCardOpacity(activePreset.defaultCardOpacity ?? CARD_GLASS_LIMITS.opacity.default);
      setCardBlur(activePreset.defaultCardBlur ?? CARD_GLASS_LIMITS.blur.default);
      setCardSaturate(activePreset.defaultCardSaturate ?? CARD_GLASS_LIMITS.saturate.default);
    } else {
      resetDefaults();
      resetCardGlassDefaults();
    }
  };

  const handleApplyCustomUrl = (e) => {
    e.preventDefault();
    const trimmed = customInput.trim();
    if (trimmed) {
      setCustomUrl(trimmed);
      showToast(t("已应用自定义图片链接"));
    }
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showToast(t("请选择有效的图片文件（支持 JPG / PNG / WebP / AVIF）"));
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const sizeMb = file.size / (1024 * 1024);
    if (sizeMb > 20) {
      showToast(t("图片体积为 {p0}MB，请选择 20MB 以内的壁纸图片", { p0: (sizeMb.toFixed(1)) }));
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    try {
      setIsProcessingFile(true);
      const result = await setLocalImage(file);
      if (!result?.ok) throw result?.error || new Error('Wallpaper could not be applied');
      showToast(result.durable
        ? '本地壁纸已保存，刷新与重启后仍可保留'
        : '本地壁纸已应用，但仅本次会话有效');
    } catch (err) {
      console.error('保存本地壁纸失败:', err);
      showToast(t("保存本地壁纸失败，请重试"));
    } finally {
      setIsProcessingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const isCustomActive = Boolean(enabled && imageStatus === 'ready' && activeSource === 'custom' && customUrl && customUrl === customInput.trim());
  const isLocalActive = Boolean(enabled && imageStatus === 'ready' && activeSource === 'local' && hasLocalImage);

  return (
    <DrawerFrame
      visible={visible}
      isFullScreen={isFullScreen}
      labelledBy="background-drawer-title"
      onClose={handleClose}
      onPanelTransitionEnd={onPanelTransitionEnd}
      panelClassName="background-drawer sm:w-[480px] overflow-y-auto"
    >
      <div className="theme-drawer__header sticky top-0 z-10 flex items-center justify-between px-6 py-5 bg-[var(--page)] border-b border-[var(--line)]">
        <h2 id="background-drawer-title" className="theme-drawer__title text-lg font-semibold flex items-center gap-2">
          <ImageIcon size={20} strokeWidth={1.8} />{t("全站背景设置")}</h2>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label={t("关闭背景设置")}
          onClick={handleClose}
          className="theme-drawer__close flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)]"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>

      <div className="flex-1 px-5 py-4 space-y-4">
        {/* 开关横条 */}
        <div className="flex items-center justify-between p-3.5 rounded-2xl bg-[var(--surface)] border border-[var(--line)]">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-[var(--ink)] flex items-center gap-1.5">
              <Sparkles size={15} className="text-[var(--accent)]" />{t("启用全站背景")}</span>
            <span className="text-[11px] text-[var(--muted)]">{t("开启自定义壁纸与卡片玻璃通透质感")}</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={toggleEnabled}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus-visible:outline-none ${
              enabled ? 'bg-[var(--accent)]' : 'bg-zinc-300 dark:bg-zinc-700'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                enabled ? 'translate-x-5' : 'translate-x-0.5'
              } mt-0.5`}
            />
          </button>
        </div>

        {imageStatus === 'error' && (
          <p role="status" className="text-xs leading-relaxed text-amber-600 dark:text-amber-300">{t("当前图片无法加载，已恢复默认背景。你可以更换图片或重试当前来源。")}</p>
        )}

        {/* 本地图片持久化选择 */}
        <div className="space-y-2.5 p-3.5 rounded-2xl bg-[var(--surface)] border border-[var(--line)]">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--ink)] flex items-center gap-1.5">
              <Upload size={14} />{t("本地图片 (IndexedDB 离线保存)")}</span>
            {isLocalActive && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)] font-medium">{t("生效中")}</span>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/avif"
            onChange={handleFileChange}
            className="hidden"
          />

          {hasLocalImage ? (
            <div className="flex items-center gap-2.5 p-2 rounded-xl bg-[var(--page)] border border-[var(--line)]">
              <div className="relative w-12 h-9 rounded-lg overflow-hidden bg-black/30 shrink-0">
                {localImageUrl ? (
                  <img
                    src={localImageUrl}
                    alt={t("本地壁纸缩略图")}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[10px] text-[var(--muted)] font-mono">
                    LOCAL
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-[var(--ink)] truncate" title={localImageName}>
                  {localImageName || t("本地壁纸")}
                </p>
                <p className="text-[10px] text-[var(--muted)] truncate">
                  {localImagePersistence === 'durable'
                    ? t("已保存在浏览器本地数据库")
                    : t("仅本次会话有效")}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {activeSource !== 'local' && (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveSource('local');
                      useWallpaperStore.getState().setEnabled(true);
                      showToast(t("已切换至本地壁纸"));
                    }}
                    className="px-2 py-1 text-xs font-semibold rounded-lg bg-[var(--accent)] text-white"
                  >{t("使用")}</button>
                )}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isProcessingFile}
                  className="px-2 py-1 text-xs font-medium rounded-lg bg-[var(--surface-raised)] border border-[var(--line)] text-[var(--ink)] hover:border-[var(--muted)]"
                >{t("更换")}</button>
                <button
                  type="button"
                  onClick={async () => {
                    const result = await removeLocalImage();
                    showToast(result?.ok ? t("已移除本地图片") : t("移除失败，请重试"));
                  }}
                  className="p-1 text-[var(--muted)] hover:text-rose-500 rounded-lg"
                  title={t("移除本地壁纸")}
                  aria-label={t("移除本地壁纸")}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessingFile}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-dashed border-[var(--line-strong)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/5 text-xs font-medium text-[var(--ink)] transition-all cursor-pointer"
            >
              <Upload size={14} className="text-[var(--accent)]" />
              <span>{isProcessingFile ? t("正在保存...") : t("从本地选择图片 (支持 JPG / PNG / WebP)")}</span>
            </button>
          )}
        </div>

        {/* 预设画廊 */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">{t("精选主题壁纸")}</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {WALLPAPER_PRESETS.map((preset) => {
              const active = enabled && imageStatus === 'ready' && activeSource === 'preset' && activePresetId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handleSelectPreset(preset.id)}
                  aria-pressed={active}
                  className={`group relative flex flex-col rounded-xl overflow-hidden border transition-all text-left focus-visible:outline-none ${
                    active
                      ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/30 shadow-md'
                      : 'border-[var(--line)] hover:border-[var(--muted)]/50'
                  }`}
                >
                  <div className="relative aspect-[16/10] w-full bg-black/40 overflow-hidden">
                    <img
                      src={preset.thumbnailUrl}
                      alt={preset.name}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                      loading="lazy"
                    />
                    {active && (
                      <div className="absolute inset-0 bg-black/35 flex items-center justify-center">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-white shadow-sm">
                          <Check size={14} strokeWidth={3} />
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="py-1.5 px-2 bg-[var(--surface)] text-center">
                    <p className="text-xs font-medium text-[var(--ink)] truncate">
                      {preset.name}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 自定义图片直链 */}
        <div className="space-y-2 p-3.5 rounded-2xl bg-[var(--surface)] border border-[var(--line)]">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--ink)] flex items-center gap-1.5">
              <Link2 size={14} />{t("图片网络直链 (URL)")}</span>
            {isCustomActive && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)] font-medium">{t("生效中")}</span>
            )}
          </div>
          <form onSubmit={handleApplyCustomUrl} className="flex gap-2">
            <input
              type="url"
              placeholder={t("https://.../bg.webp (含敏感签名或令牌请勿填)")}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              className="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-xl bg-[var(--page)] border border-[var(--line)] text-[var(--ink)] placeholder:text-[var(--muted)]/50 focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              type="submit"
              disabled={!customInput.trim() || isCustomActive}
              className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-[var(--accent)] text-white disabled:opacity-40 transition-opacity"
            >{t("应用")}</button>
          </form>
        </div>

        {/* 未启用壁纸时的友好状态提示 */}
        {!enabled && (
          <div className="flex items-center gap-2 p-3 rounded-2xl bg-[var(--surface-sunken)] border border-[var(--line)] text-xs text-[var(--muted)]">
            <Sparkles size={14} className="text-[var(--accent)] shrink-0" />
            <span>{t("开启背景壁纸后，画面调节与卡片通透度将实时生效")}</span>
          </div>
        )}

        {/* 画面与卡片质感统一调节板块 */}
        <div className={`space-y-4 p-3.5 rounded-2xl bg-[var(--surface)] border border-[var(--line)] transition-opacity ${!enabled ? 'opacity-65' : 'opacity-100'}`}>
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-[var(--ink)] flex items-center gap-1.5">
                <Layers size={14} className="text-[var(--accent)]" />{t("画面与卡片质感调节")}</span>
              <span className="text-[10px] text-[var(--muted)] mt-0.5">{t("一键联动虚化、遮罩与卡片通透度")}</span>
            </div>
            <button
              type="button"
              onClick={handleResetDefaults}
              className="text-xs text-[var(--muted)] hover:text-[var(--accent)] flex items-center gap-1 transition-colors"
              title={t("恢复当前主题推荐默认")}
            >
              <RotateCcw size={12} />
              <span>{t("恢复默认")}</span>
            </button>
          </div>

          {/* 3 个参数协同的快捷风格预设 */}
          <div className="flex items-center gap-2 pt-0.5">
            {Object.values(CARD_GLASS_PRESETS).map((preset) => {
              const isPresetActive = (
                cardOpacity === preset.opacity &&
                blur === (preset.wallpaperBlur ?? blur) &&
                opacity === (preset.wallpaperOpacity ?? opacity)
              );
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setCardGlassPreset(preset.id)}
                  aria-pressed={isPresetActive}
                  className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-xl border transition-all ${
                    isPresetActive
                      ? 'bg-[var(--accent)] text-white border-[var(--accent)] shadow-sm'
                      : 'bg-[var(--page)] text-[var(--ink)] border-[var(--line)] hover:border-[var(--muted)]/60'
                  }`}
                >
                  {preset.name}
                </button>
              );
            })}
          </div>

          {/* 三个黄金参数滑块列表 */}
          <div className="space-y-3.5 pt-1 border-t border-[var(--line)]/60">
            {/* 背景模糊度 */}
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--ink)] flex items-center gap-1.5">
                  <Droplet size={13} className="text-cyan-500" />{t("背景模糊度 (Blur)")}</span>
                <span className="font-mono text-cyan-600 dark:text-cyan-400">{blur}px</span>
              </div>
              <input
                type="range"
                min={WALLPAPER_LIMITS.blur.min}
                max={WALLPAPER_LIMITS.blur.max}
                step={1}
                value={blur}
                onChange={(e) => setBlur(e.target.value)}
                className="w-full accent-cyan-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-[var(--muted)] font-mono">
                <span>{t("清晰 (")}{WALLPAPER_LIMITS.blur.min}px)</span>
                <span>{t("柔焦 (")}{WALLPAPER_LIMITS.blur.max}px)</span>
              </div>
            </div>

            {/* 自适应遮罩 */}
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--ink)] flex items-center gap-1.5">
                  <Sliders size={13} className="text-indigo-500" />{t("自适应遮罩 (Mask)")}</span>
                <span className="font-mono text-indigo-600 dark:text-indigo-400">{opacity}%</span>
              </div>
              <input
                type="range"
                min={WALLPAPER_LIMITS.opacity.min}
                max={WALLPAPER_LIMITS.opacity.max}
                step={1}
                value={opacity}
                onChange={(e) => setOpacity(e.target.value)}
                className="w-full accent-indigo-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-[var(--muted)] font-mono">
                <span>{t("轻透 (")}{WALLPAPER_LIMITS.opacity.min}%)</span>
                <span>{t("浓郁 (")}{WALLPAPER_LIMITS.opacity.max}%)</span>
              </div>
            </div>

            {/* 表面不透明度 */}
            <div className="space-y-1">
              <div className="flex justify-between items-center text-xs font-medium text-[var(--ink)]">
                <label htmlFor="card-glass-opacity" className="flex items-center gap-1.5">
                  <Sun size={13} className="text-amber-500" />
                  <span>{t("卡片通透度 (Opacity)")}</span>
                </label>
                <span className="font-mono text-amber-600 dark:text-amber-400">{cardOpacity}%</span>
              </div>
              <input
                id="card-glass-opacity"
                type="range"
                min={CARD_GLASS_LIMITS.opacity.min}
                max={CARD_GLASS_LIMITS.opacity.max}
                step={CARD_GLASS_LIMITS.opacity.step}
                value={cardOpacity}
                onChange={(e) => setCardOpacity(e.target.value)}
                className="w-full accent-amber-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-[var(--muted)]">
                <span>{t("通透 (")}{CARD_GLASS_LIMITS.opacity.min}%)</span>
                <span>{t("凝实 (")}{CARD_GLASS_LIMITS.opacity.max}%)</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </DrawerFrame>
  );
}
