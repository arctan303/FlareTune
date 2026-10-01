import { t } from '../../i18n/index.js';
import React from 'react';
import { useThemeStore } from '../../store/useThemeStore';
import { showToast } from '../../store/useUIStore';
import { LYRIC_EFFECTS, getEffectConfig } from '../../constants/lyricEffects';

export default function ThemeDebugger() {
    const { 
        showDebugger, setShowDebugger,
        glassMaterial, setGlassMaterial,
        accentColor, setAccentColor,
        fontFamily, setFontFamily,
        lyricTransition, setLyricTransition,
        lyricShadow, setLyricShadow,
        resolvedTransition,
        exportConfig 
    } = useThemeStore();

    if (import.meta.env.VITE_ENABLE_THEME_DEBUGGER !== 'true') {
        return null;
    }

    if (!showDebugger) {
        return (
            <button 
                onClick={() => setShowDebugger(true)}
                className="fixed top-24 right-8 z-[100] px-4 py-2 bg-white/10 hover:bg-white/20 backdrop-blur-md rounded-full text-white/70 hover:text-white transition-all text-sm font-medium border border-white/10"
            >{t("调色盘 (Tune)")}</button>
        );
    }

    const handleCopy = () => {
        const config = exportConfig();
        navigator.clipboard.writeText(config);
        showToast(t("参数已复制到剪贴板！"));
    };

    const resolvedEffect = getEffectConfig(
        lyricTransition === 'random' ? resolvedTransition : lyricTransition,
    );
    const currentEffectName = lyricTransition === 'random'
        ? `🎲 ${resolvedEffect.name}`
        : null;

    return (
        <div className="fixed top-24 right-8 z-[100] w-80 bg-black/60 backdrop-blur-2xl border border-white/20 rounded-3xl p-6 text-white shadow-2xl flex flex-col gap-6 animate-[fade-in_0.3s_ease-out]">
            <div className="flex items-center justify-between">
                <h3 className="font-bold text-lg tracking-wider">{t("主题实验室")}</h3>
                <button onClick={() => setShowDebugger(false)} className="text-white/50 hover:text-white text-xl leading-none">&times;</button>
            </div>

            <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    <label className="text-xs text-white/50 uppercase tracking-widest font-semibold">{t("面板质感")}</label>
                    <select 
                        value={glassMaterial} 
                        onChange={e => setGlassMaterial(e.target.value)}
                        className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 outline-none text-sm focus:border-white/50"
                    >
                        <option value="glass-light" className="text-black">{t("高透白玻璃 (默认)")}</option>
                        <option value="glass-dark" className="text-black">{t("暗色深磨砂 (夜间)")}</option>
                        <option value="glass-invisible" className="text-black">{t("全透明无边界")}</option>
                    </select>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="text-xs text-white/50 uppercase tracking-widest font-semibold">{t("强调色")}</label>
                    <select 
                        value={accentColor} 
                        onChange={e => setAccentColor(e.target.value)}
                        className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 outline-none text-sm focus:border-white/50"
                    >
                        <option value="#3b82f6" className="text-black">{t("科技蓝 (Ocean Blue)")}</option>
                        <option value="#10b981" className="text-black">{t("治愈绿 (Nature Green)")}</option>
                        <option value="#f59e0b" className="text-black">{t("日落橘 (Sunset Orange)")}</option>
                        <option value="#ffffff" className="text-black">{t("纯净白 (Pure White)")}</option>
                    </select>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="text-xs text-white/50 uppercase tracking-widest font-semibold">{t("歌词字体")}</label>
                    <select 
                        value={fontFamily} 
                        onChange={e => setFontFamily(e.target.value)}
                        className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 outline-none text-sm focus:border-white/50"
                    >
                        <option value="font-sans" className="text-black">{t("系统默认 (黑体/苹方)")}</option>
                        <option value="font-serif" className="text-black">{t("诗意衬线 (宋体/明体)")}</option>
                        <option value="font-kai" className="text-black">{t("书法楷体 (楷体/华文楷体)")}</option>
                        <option value="font-round" className="text-black">{t("柔和圆体 (圆体/思源)")}</option>
                        <option value="font-mono" className="text-black">{t("复古等宽 (Monospace)")}</option>
                    </select>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="text-xs text-white/50 uppercase tracking-widest font-semibold">{t("歌词动效")}{currentEffectName && (
                            <span className="ml-2 text-white/70 normal-case tracking-normal">{t("当前:")}{currentEffectName}
                            </span>
                        )}
                    </label>
                    <select 
                        value={lyricTransition} 
                        onChange={e => setLyricTransition(e.target.value)}
                        className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 outline-none text-sm focus:border-white/50"
                    >
                        <option value="random" className="text-black">{t("🎲 随机 (每首歌不同)")}</option>
                        {LYRIC_EFFECTS.map((fx) => (
                            <option key={fx.id} value={fx.id} className="text-black">
                                {fx.wordEvent !== 'none' ? '⚡ ' : ''}{fx.name} — {fx.desc}
                            </option>
                        ))}
                    </select>
                    <p
                        className="text-[11px] leading-relaxed text-white/45"
                        data-resolved-lyric-effect={resolvedEffect.id}
                    >{t("解析：")}{resolvedEffect.id} · {resolvedEffect.group}{' '}{t("· 原文")}{' '}{resolvedEffect.wordEvent}{' '}{t("· 译文")}{' '}{resolvedEffect.translationProgress}
                    </p>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="text-xs text-white/50 uppercase tracking-widest font-semibold">{t("文字发光")}</label>
                    <select 
                        value={lyricShadow} 
                        onChange={e => setLyricShadow(e.target.value)}
                        className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 outline-none text-sm focus:border-white/50"
                    >
                        <option value="heavy" className="text-black">{t("重度发光 (推荐浅色背景)")}</option>
                        <option value="light" className="text-black">{t("轻微阴影")}</option>
                        <option value="none" className="text-black">{t("纯平无阴影 (推荐纯黑背景)")}</option>
                    </select>
                </div>
            </div>

            <button 
                onClick={handleCopy}
                className="mt-2 w-full py-3 bg-white text-black font-bold rounded-xl hover:bg-white/90 transition-colors"
            >{t("复制当前参数配置")}</button>
        </div>
    );
}
