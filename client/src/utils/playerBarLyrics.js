export function getPlayerBarLyricLayout({
    translationEnabled,
    canTranslate = true,
    lyrics,
    currentLyricIndex,
}) {
    const hasInlineTranslation = (line) => {
        if (typeof line?.text !== 'string') return false;
        const parts = line.text.split('\n').map((part) => part.trim()).filter(Boolean);
        if (parts.length < 2) return false;
        const originalHasHan = /[\u3400-\u9fff]/.test(parts[0]);
        const translatedHasHan = /[\u3400-\u9fff]/.test(parts.slice(1).join(' '));
        return translatedHasHan && !originalHasHan;
    };
    const translatableLines = Array.isArray(lyrics)
        ? lyrics.filter((line) => !line?.isIntro)
        : [];
    const hasTranslation = translatableLines.some((line) => {
        if (typeof line?.translation === 'string' && line.translation.trim()) return true;
        return hasInlineTranslation(line);
    });
    const isBilingual = Boolean(canTranslate && translationEnabled) && hasTranslation;
    const rowHeight = isBilingual ? 36 : 18;
    return {
        isBilingual,
        rowHeight,
        translateY: Math.max(0, Number(currentLyricIndex) || 0) * rowHeight,
    };
}
