import { t } from '../i18n/index.js';
import React, { useState, useEffect, useRef } from 'react';
import {
  Sun,
  Moon,
  Monitor,
  Check,
  RotateCcw,
  Link2,
  Upload,
  Trash2,
  User,
} from 'lucide-react';
import { formatPath, syncBrowserHistory } from '../utils/navigation.js';
import { useUIStore, showToast } from '../store/useUIStore.js';
import { useWallpaperStore } from '../store/useWallpaperStore.js';
import { usePlayerStore } from '../store/usePlayerStore.js';
import {
  WALLPAPER_PRESETS,
  WALLPAPER_LIMITS,
  CARD_GLASS_LIMITS,
  CARD_GLASS_PRESETS,
} from '../constants/wallpaperPresets.js';
import { AVAILABLE_PLAYER_MODES, PLAYER_MODE_META } from '../constants/playerModes.js';
import { resolveCoverUrl } from '../utils.js';
import AccountSettings from './AccountSettings.jsx';
import PrivateCoverImage from './PrivateCoverImage.jsx';

const AdminView = React.lazy(() => import('./AdminView.jsx'));
const AdminSongCreatePage = React.lazy(() => import('./AdminSongCreatePage.jsx'));

/**
 * 播放器形态微缩沙盘模型
 */
function PlayerModeMockup({ mode, coverUrl }) {
  if (mode === 'cinematic') {
    return (
      <div className="player-skin-mockup player-skin-mockup--cinematic relative w-full h-full rounded-xl overflow-hidden flex flex-col justify-between p-2.5 select-none transition-all duration-300">
        <div className="absolute inset-0 bg-gradient-to-br from-[#24202c] via-[#181a28] to-[#10151b]" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/20 to-black/75" />
        <div
          className="absolute inset-0 opacity-50 transition-opacity duration-500"
          style={{ background: 'radial-gradient(ellipse 80% 60% at 50% 45%, rgba(236, 72, 153, 0.4) 0%, transparent 70%)' }}
        />
        <div className="relative z-10 flex items-center justify-between opacity-80">
          <div className="w-1.5 h-1 border-b-2 border-l-2 border-white -rotate-45" />
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-black/50 backdrop-blur-sm text-white/90 border border-white/10 font-medium flex items-center gap-1">
            <User size={9} strokeWidth={2.4} />
            <span>{t("写真")}</span>
          </span>
        </div>
        <div className="relative z-10 flex flex-col items-center gap-1.5 my-auto">
          <div className="h-1 rounded-full bg-white/35 w-[38%]" />
          <div className="h-2.5 rounded-full bg-white w-[68%] shadow-[0_0_10px_rgba(255,255,255,0.9)] my-0.5" />
          <div className="h-1 rounded-full bg-white/30 w-[48%]" />
        </div>
        <div className="relative z-10 mx-auto w-[46%] h-3 rounded-full bg-white/20 border border-white/30 backdrop-blur-md flex items-center justify-between px-2 shadow-sm">
          <div className="w-1.5 h-1.5 rounded-full bg-white/60" />
          <div className="w-2 h-2 rounded-full bg-white shadow-[0_0_5px_rgba(255,255,255,0.9)]" />
          <div className="w-1.5 h-1.5 rounded-full bg-white/60" />
        </div>
      </div>
    );
  }

  // 经典双栏 Classic
  return (
    <div className="player-skin-mockup player-skin-mockup--classic relative w-full h-full rounded-xl overflow-hidden p-2.5 flex flex-col justify-between select-none transition-all duration-300 bg-gradient-to-br from-[#303338] via-[#202226] to-[#141518] border border-white/10 text-white">
      <div
        className="absolute -left-3 -top-3 w-24 h-24 rounded-full opacity-35 blur-xl pointer-events-none"
        style={{ background: 'color-mix(in srgb, var(--accent, #3b82f6) 40%, white 20%)' }}
      />
      <div className="relative z-10 flex items-center justify-between opacity-60">
        <div className="w-1.5 h-1 border-b-2 border-l-2 border-white -rotate-45" />
        <div className="w-2 h-2 rounded-full bg-white/40" />
      </div>
      <div className="relative z-10 flex items-stretch gap-2.5 flex-1 min-h-0 my-0.5">
        <div className="w-[43%] flex flex-col justify-between shrink-0">
          <div className="relative w-full aspect-square rounded-lg overflow-hidden border border-white/20 shadow-lg bg-black/60 shrink-0">
            <PrivateCoverImage
              src={coverUrl}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </div>
          <div className="w-full flex flex-col gap-0.5 mt-0.5">
            <div className="h-1.5 w-[75%] rounded-full bg-white font-bold" />
            <div className="w-full h-0.5 rounded-full bg-white/20 overflow-hidden">
              <div className="h-full bg-white w-[42%]" />
            </div>
            <div className="flex items-center justify-between opacity-70 pt-0.5">
              <div className="w-1.5 h-1.5 rounded-full bg-white/40" />
              <div className="w-2 h-2 rounded-full bg-white shadow-sm" />
              <div className="w-1.5 h-1.5 rounded-full bg-white/40" />
            </div>
          </div>
        </div>
        <div className="flex-1 flex flex-col justify-center gap-1 min-w-0 pr-0.5 pl-0.5">
          <div className="h-1 rounded-full bg-white/20 w-[60%]" />
          <div className="h-2 rounded-full bg-white w-[92%] shadow-[0_0_8px_rgba(255,255,255,0.8)] my-0.5" />
          <div className="h-1 rounded-full bg-white/30 w-[55%]" />
          <div className="h-1 rounded-full bg-white/25 w-[75%]" />
          <div className="h-1 rounded-full bg-white/20 w-[85%]" />
          <div className="h-1 rounded-full bg-white/10 w-[45%]" />
        </div>
      </div>
    </div>
  );
}

export default function SettingsView({ section, themePreference = 'system', selectTheme }) {
  const playerMode = useUIStore((state) => state.playerMode);
  const setPlayerMode = useUIStore((state) => state.setPlayerMode);
  const authSession = useUIStore((state) => state.authSession);

  const isAdmin = authSession?.authenticated && authSession?.user?.role === 'admin';
  const validSections = ['personal', 'appearance', 'admin-assistant', 'admin-catalog', 'admin-add-song', 'admin-accounts', 'admin-system'];
  const requestedSection = section || 'appearance';
  const activeSection = validSections.includes(requestedSection)
    && (isAdmin || !requestedSection.startsWith('admin'))
    ? requestedSection
    : 'appearance';

  useEffect(() => {
    const path = formatPath({ type: 'page', page: 'settings', section: activeSection });
    if (window.location.pathname !== path) syncBrowserHistory(path, { replace: true });
  }, [activeSection]);

  // 壁纸 Store 状态
  const enabled = useWallpaperStore((s) => s.enabled);
  const imageStatus = useWallpaperStore((s) => s.imageStatus);
  const setImageStatus = useWallpaperStore((s) => s.setImageStatus);
  const toggleEnabled = useWallpaperStore((s) => s.toggleEnabled);
  const activeSource = useWallpaperStore((s) => s.activeSource);
  const activePresetId = useWallpaperStore((s) => s.activePresetId);
  const customUrl = useWallpaperStore((s) => s.customUrl);
  const hasLocalImage = useWallpaperStore((s) => s.hasLocalImage);
  const localImageName = useWallpaperStore((s) => s.localImageName);
  const localImageUrl = useWallpaperStore((s) => s.localImageUrl);
  const localImagePersistence = useWallpaperStore((s) => s.localImagePersistence);
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

  // 播放器状态
  const currentSong = usePlayerStore((s) => s.currentSong);
  const coverUrl = resolveCoverUrl(currentSong?.cover_url || '');

  // 本地组件状态
  const [wallpaperTab, setWallpaperTab] = useState('preset'); // 'preset' | 'custom' | 'upload'
  const [customInput, setCustomInput] = useState(customUrl || '');
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    setCustomInput(customUrl || '');
  }, [customUrl]);

  // 同步 activeSource 到 tab
  useEffect(() => {
    if (activeSource === 'preset') setWallpaperTab('preset');
    else if (activeSource === 'custom') setWallpaperTab('custom');
    else if (activeSource === 'local') setWallpaperTab('upload');
  }, [activeSource]);

  // 重置质感参数
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
    showToast(t("已恢复默认质感参数"));
  };

  const handleApplyCustomUrl = (e) => {
    e.preventDefault();
    const trimmed = customInput.trim();
    if (trimmed) {
      setCustomUrl(trimmed);
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
        ? '本地图片已保存，正在加载背景'
        : '本地图片已载入，正在加载背景（仅本次会话有效）');
    } catch (err) {
      showToast(t("本地壁纸加载失败，请重试"));
    } finally {
      setIsProcessingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemoveLocalImage = async () => {
    const result = await removeLocalImage();
    showToast(result?.ok ? '已清除本地壁纸' : '清除失败，请重试');
  };

  return (
    <div className="app-page settings-page pb-28">
      <div className="settings-main-pane mx-auto w-full max-w-4xl">
          {/* 分支 1：外观与样式 */}
          {activeSection === 'appearance' && (
            <div className="space-y-6 sm:space-y-7 animate-[fade-in_0.2s_ease-out]">
              <header className="border-b border-[var(--line)] pb-4">
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--ink)]">{t("外观与样式")}</h1>
              </header>

              {/* 模块 1：外观与色彩模式 */}
              <section aria-labelledby="settings-theme-title" className="space-y-2.5">
                <div>
                  <h2 id="settings-theme-title" className="text-sm font-bold text-[var(--ink)]">{t("外观模式")}</h2>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl" role="group" aria-label={t("外观模式")}>
                  {[
                    { id: 'system', label: t("跟随系统"), detail: t("随设备自动切换"), icon: Monitor },
                    { id: 'light', label: t("浅色模式"), icon: Sun },
                    { id: 'dark', label: t("深色模式"), icon: Moon },
                  ].map(({ id, label, detail, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => selectTheme?.(id)}
                      aria-pressed={themePreference === id}
                      className={`wallpaper-content-surface ${themePreference === id ? 'wallpaper-content-surface--selected' : ''} flex items-center justify-between gap-2.5 p-3 rounded-xl border transition-all cursor-pointer text-left ${themePreference === id
                        ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface-raised))] text-[var(--ink)] shadow-2xs'
                        : 'border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)] hover:border-[var(--line-strong)]'}`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="w-7 h-7 rounded-lg bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))] text-[var(--accent)] flex items-center justify-center shrink-0"><Icon size={15} strokeWidth={2} /></span>
                        <span className="min-w-0"><strong className="block text-xs font-semibold">{t(label)}</strong>{detail && <span className="block text-[10px] opacity-70">{t(detail)}</span>}</span>
                      </div>
                      {themePreference === id && <Check size={15} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              </section>

              {/* 模块 2：播放器外观 */}
              <section aria-labelledby="settings-player-skin-title" className="space-y-2.5">
                <div>
                  <h2 id="settings-player-skin-title" className="text-sm font-bold text-[var(--ink)]">{t("播放器外观")}</h2>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-3.5">
                  {AVAILABLE_PLAYER_MODES.map((mode) => {
                    const meta = PLAYER_MODE_META[mode];
                    if (!meta) return null;
                    const active = mode === playerMode;
                    const Icon = meta.icon;

                    return (
                      <div
                        key={mode}
                        onClick={() => setPlayerMode(mode)}
                        className={`wallpaper-content-surface ${active ? 'wallpaper-content-surface--selected' : ''} group flex items-center gap-3.5 rounded-2xl p-3 border transition-all cursor-pointer ${
                          active
                            ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_6%,var(--surface-raised))] shadow-2xs'
                            : 'border-[var(--line)] bg-[var(--surface)] hover:border-[var(--line-strong)]'
                        }`}
                      >
                        {/* 左侧：严格 16:10 黄金比例微缩沙盘 (绝不拉伸变形，高度紧凑) */}
                        <div className="w-40 sm:w-44 lg:w-48 aspect-[16/10] rounded-xl overflow-hidden border border-white/15 shadow-2xs shrink-0 bg-black/40">
                          <PlayerModeMockup
                            mode={mode}
                            coverUrl={coverUrl}
                          />
                        </div>

                        {/* 右侧：信息与控制区 */}
                        <div className="flex-1 min-w-0 flex flex-col justify-between self-stretch py-0.5">
                          <div className="space-y-1">
                            <div className="flex items-center justify-between gap-1.5">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-current/10 text-[var(--accent)]">
                                  <Icon size={12} strokeWidth={2} />
                                </span>
                                <strong className="text-xs font-semibold text-[var(--ink)] truncate">
                                  {t(meta.name)}
                                </strong>
                              </div>

                              {active && (
                                <div className="w-4 h-4 rounded-full bg-[var(--accent)] text-white flex items-center justify-center shrink-0">
                                  <Check size={10} strokeWidth={3} />
                                </div>
                              )}
                            </div>

                          </div>

                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* 模块 3：全站壁纸与质感调节 */}
              <section aria-labelledby="settings-wallpaper-title" className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 id="settings-wallpaper-title" className="text-sm font-bold text-[var(--ink)]">{t("全站壁纸与质感")}</h2>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-[var(--muted)]">
                      {enabled ? t("已开启") : t("已关闭")}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-label={t("启用全站壁纸")}
                      aria-checked={enabled}
                      onClick={toggleEnabled}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none ${
                        enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line)]'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-xs ring-0 transition duration-200 ease-in-out ${
                          enabled ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {enabled && imageStatus === 'loading' && (
                  <p role="status" className="text-xs text-[var(--muted)]">{t("正在加载背景图片…")}</p>
                )}
                {enabled && imageStatus === 'ready' && (
                  <p role="status" className="text-xs text-[var(--muted)]">{t("背景已应用")}</p>
                )}
                {enabled && imageStatus === 'error' && (
                  <div role="alert" className="flex items-center gap-3 text-xs text-red-600 dark:text-red-400">
                    <span>{t("背景图片加载失败，请检查图片地址或选择其他图片。")}</span>
                    <button type="button" className="underline" onClick={() => setImageStatus('loading')}>{t("重试")}</button>
                  </div>
                )}

                {/* 壁纸配置面板 */}
                {enabled && (
                  <div className="wallpaper-content-surface rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-4 sm:p-5 space-y-4 shadow-2xs">
                    {/* 来源切换 Tabs */}
                    <div className="flex items-center gap-1 p-0.5 rounded-xl bg-current/5 border border-[var(--line)] max-w-xs">
                      <button
                        type="button"
                        onClick={() => setWallpaperTab('preset')}
                        className={`flex-1 py-1 px-2.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                          wallpaperTab === 'preset'
                            ? 'bg-[var(--surface)] text-[var(--ink)] shadow-2xs'
                            : 'text-[var(--muted)] hover:text-[var(--ink)]'
                        }`}
                      >{t("精选壁纸")}</button>
                      <button
                        type="button"
                        onClick={() => setWallpaperTab('custom')}
                        className={`flex-1 py-1 px-2.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                          wallpaperTab === 'custom'
                            ? 'bg-[var(--surface)] text-[var(--ink)] shadow-2xs'
                            : 'text-[var(--muted)] hover:text-[var(--ink)]'
                        }`}
                      >{t("网络链接")}</button>
                      <button
                        type="button"
                        onClick={() => setWallpaperTab('upload')}
                        className={`flex-1 py-1 px-2.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                          wallpaperTab === 'upload'
                            ? 'bg-[var(--surface)] text-[var(--ink)] shadow-2xs'
                            : 'text-[var(--muted)] hover:text-[var(--ink)]'
                        }`}
                      >{t("本地上传")}</button>
                    </div>

                    {/* Tab 1: 精选壁纸网格 (6 列紧凑排布) */}
                    {wallpaperTab === 'preset' && (
                      <div className="space-y-2">
                        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                          {WALLPAPER_PRESETS.map((preset) => {
                            const isSelected = activeSource === 'preset' && activePresetId === preset.id;
                            return (
                              <button
                                key={preset.id}
                                type="button"
                                onClick={() => setPreset(preset.id, true)}
                                className={`group relative flex flex-col rounded-xl overflow-hidden border text-left transition-all cursor-pointer aspect-[16/10] ${
                                  isSelected
                                    ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/30 shadow-xs'
                                    : 'border-[var(--line)] hover:border-[var(--line-strong)]'
                                }`}
                              >
                                <img
                                  src={preset.thumbnailUrl}
                                  alt={preset.name}
                                  referrerPolicy="no-referrer"
                                  className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                  loading="lazy"
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
                                <div className="relative mt-auto p-1.5 z-10 flex items-center justify-between w-full">
                                  <span className="text-[11px] font-semibold text-white drop-shadow-sm truncate pr-1">
                                    {preset.name}
                                  </span>
                                  {isSelected && (
                                    <div className="w-3.5 h-3.5 rounded-full bg-[var(--accent)] text-white flex items-center justify-center shrink-0">
                                      <Check size={8} strokeWidth={3} />
                                    </div>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Tab 2: 网络图片链接 */}
                    {wallpaperTab === 'custom' && (
                      <form onSubmit={handleApplyCustomUrl} className="space-y-2.5 max-w-md">
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <Link2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                            <input
                              type="url"
                              required
                              value={customInput}
                              onChange={(e) => setCustomInput(e.target.value)}
                              placeholder="https://example.com/wallpaper.jpg"
                              className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink)] placeholder:text-[var(--muted)] focus-visible:outline-none focus-visible:border-[var(--accent)]"
                            />
                          </div>
                          <button
                            type="submit"
                            className="primary-button py-1.5 px-3.5 rounded-lg text-xs font-semibold shrink-0"
                          >{t("应用链接")}</button>
                        </div>
                      </form>
                    )}

                    {/* Tab 3: 本地图片上传 */}
                    {wallpaperTab === 'upload' && (
                      <div className="space-y-3 max-w-md">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/avif"
                          onChange={handleFileChange}
                          className="hidden"
                        />

                        {hasLocalImage ? (
                          <div className="flex items-center justify-between p-2.5 rounded-xl bg-[var(--surface)] border border-[var(--line)]">
                            <div className="flex items-center gap-2.5 min-w-0">
                              {localImageUrl && (
                                <img
                                  src={localImageUrl}
                                  alt={t("本地壁纸预览")}
                                  className="w-10 h-10 rounded-lg object-cover border border-[var(--line)] shrink-0"
                                />
                              )}
                              <div className="min-w-0 space-y-0.5">
                                <span className="block text-xs font-semibold text-[var(--ink)] truncate">
                                  {localImageName || t("本地已上传壁纸")}
                                </span>
                                <span className="block text-[10px] text-[var(--accent)]">
                                  {localImagePersistence === 'durable' ? t("已离线保存在本地浏览器") : t("临时会话有效")}
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5">
                              {activeSource !== 'local' && localImageUrl && (
                                <button type="button" onClick={() => setActiveSource('local')} className="text-xs font-semibold text-[var(--accent)] px-2 py-1">{t("使用")}</button>
                              )}
                              <button
                                type="button"
                                onClick={() => void handleRemoveLocalImage()}
                                className="p-1.5 text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors cursor-pointer"
                                title={t("清除本地壁纸")}
                                aria-label={t("清除本地壁纸")}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isProcessingFile}
                            className="w-full py-5 px-3 rounded-xl border border-dashed border-[var(--line)] hover:border-[var(--accent)] bg-[var(--surface)] flex flex-col items-center justify-center gap-1.5 transition-all cursor-pointer group"
                          >
                            <div className="w-8 h-8 rounded-full bg-[var(--accent)]/10 text-[var(--accent)] flex items-center justify-center group-hover:scale-105 transition-transform">
                              <Upload size={15} />
                            </div>
                            <div className="text-center">
                              <span className="block text-xs font-semibold text-[var(--ink)]">
                                {isProcessingFile ? t("正在处理图片...") : t("点击上传本地壁纸图片")}
                              </span>
                              <span className="block text-[10px] text-[var(--muted)] mt-0.5">{t("支持 JPG / PNG / WebP / AVIF，最大 20MB")}</span>
                            </div>
                          </button>
                        )}
                      </div>
                    )}

                    {/* 质感微调滑块 */}
                    <div className="pt-4 border-t border-[var(--line)] space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <h3 className="text-xs font-bold text-[var(--ink)]">{t("画面与卡片质感调节")}</h3>
                        </div>
                        <button
                          type="button"
                          onClick={handleResetDefaults}
                          className="inline-flex items-center gap-1 text-[11px] text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer transition-colors"
                        >
                          <RotateCcw size={11} />
                          <span>{t("重置默认")}</span>
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                        {/* 模糊度 */}
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px] text-[var(--muted)]">
                            <label htmlFor="wallpaper-blur">{t("背景模糊度 (Blur)")}</label>
                            <span className="font-mono text-[var(--ink)]">{blur}px</span>
                          </div>
                          <input
                            id="wallpaper-blur"
                            type="range"
                            min={WALLPAPER_LIMITS.blur.min}
                            max={WALLPAPER_LIMITS.blur.max}
                            step={WALLPAPER_LIMITS.blur.step}
                            value={blur}
                            onChange={(e) => setBlur(Number(e.target.value))}
                            className="w-full accent-[var(--accent)] cursor-pointer"
                          />
                        </div>

                        {/* 遮罩强度 */}
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px] text-[var(--muted)]">
                            <label htmlFor="wallpaper-overlay">{t("背景遮罩强度 (Overlay)")}</label>
                            <span className="font-mono text-[var(--ink)]">{opacity}%</span>
                          </div>
                          <input
                            id="wallpaper-overlay"
                            type="range"
                            min={WALLPAPER_LIMITS.opacity.min}
                            max={WALLPAPER_LIMITS.opacity.max}
                            step={WALLPAPER_LIMITS.opacity.step}
                            value={opacity}
                            onChange={(e) => setOpacity(Number(e.target.value))}
                            className="w-full accent-[var(--accent)] cursor-pointer"
                          />
                        </div>

                        {/* 亮度 */}
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px] text-[var(--muted)]">
                            <label htmlFor="wallpaper-brightness">{t("背景亮度 (Brightness)")}</label>
                            <span className="font-mono text-[var(--ink)]">{brightness}%</span>
                          </div>
                          <input
                            id="wallpaper-brightness"
                            type="range"
                            min={WALLPAPER_LIMITS.brightness.min}
                            max={WALLPAPER_LIMITS.brightness.max}
                            step={WALLPAPER_LIMITS.brightness.step}
                            value={brightness}
                            onChange={(e) => setBrightness(Number(e.target.value))}
                            className="w-full accent-[var(--accent)] cursor-pointer"
                          />
                        </div>

                        {/* 卡片毛玻璃模糊 */}
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px] text-[var(--muted)]">
                            <label htmlFor="wallpaper-card-blur">{t("卡片毛玻璃 (Card Blur)")}</label>
                            <span className="font-mono text-[var(--ink)]">{cardBlur}px</span>
                          </div>
                          <input
                            id="wallpaper-card-blur"
                            type="range"
                            min={CARD_GLASS_LIMITS.blur.min}
                            max={CARD_GLASS_LIMITS.blur.max}
                            step={CARD_GLASS_LIMITS.blur.step}
                            value={cardBlur}
                            onChange={(e) => setCardBlur(Number(e.target.value))}
                            className="w-full accent-[var(--accent)] cursor-pointer"
                          />
                        </div>

                        {/* 卡片通透度 */}
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px] text-[var(--muted)]">
                            <label htmlFor="wallpaper-card-opacity">{t("卡片通透度 (Opacity)")}</label>
                            <span className="font-mono text-[var(--ink)]">{cardOpacity}%</span>
                          </div>
                          <input
                            id="wallpaper-card-opacity"
                            type="range"
                            min={CARD_GLASS_LIMITS.opacity.min}
                            max={CARD_GLASS_LIMITS.opacity.max}
                            step={CARD_GLASS_LIMITS.opacity.step}
                            value={cardOpacity}
                            onChange={(e) => setCardOpacity(Number(e.target.value))}
                            className="w-full accent-[var(--accent)] cursor-pointer"
                          />
                        </div>

                        {/* 卡片饱和度 */}
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px] text-[var(--muted)]">
                            <label htmlFor="wallpaper-card-saturate">{t("卡片饱和度 (Saturate)")}</label>
                            <span className="font-mono text-[var(--ink)]">{cardSaturate}%</span>
                          </div>
                          <input
                            id="wallpaper-card-saturate"
                            type="range"
                            min={CARD_GLASS_LIMITS.saturate.min}
                            max={CARD_GLASS_LIMITS.saturate.max}
                            step={CARD_GLASS_LIMITS.saturate.step}
                            value={cardSaturate}
                            onChange={(e) => setCardSaturate(Number(e.target.value))}
                            className="w-full accent-[var(--accent)] cursor-pointer"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}

          {activeSection === 'personal' && <AccountSettings />}

          {/* 分支 3：系统管理各个子页面 */}
          {activeSection === 'admin-add-song' && isAdmin && (
            <React.Suspense fallback={<p role="status" className="py-8 text-sm text-[var(--muted)]">{t("正在打开歌曲入库…")}</p>}>
              <AdminSongCreatePage />
            </React.Suspense>
          )}

          {activeSection.startsWith('admin-') && activeSection !== 'admin-add-song' && isAdmin && (
            <div className="space-y-8 animate-[fade-in_0.2s_ease-out]">
              <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-[var(--ink)]">
                {{ 'admin-assistant': t("AI 与助手"), 'admin-catalog': t("曲库管理"), 'admin-accounts': t("账号管理"), 'admin-system': t("实例设置") }[activeSection] || t("站点管理")}
              </h1>
              <React.Suspense fallback={<p role="status" className="py-8 text-sm text-[var(--muted)]">{t("正在打开站点管理…")}</p>}>
                <AdminView
                  embeddedTab={activeSection.replace('admin-', '')}
                />
              </React.Suspense>
            </div>
          )}
      </div>
    </div>
  );
}
