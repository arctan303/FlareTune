// Placeholder rows created by the lyrics loader (useLyricsFetcher) carry
// source-language status text. Surfaces that render them show the interface
// language instead; real lyric rows always keep their original language.
export const LYRIC_STATUS_TEXTS = Object.freeze(['纯音乐，请欣赏', '暂无歌词', '歌词加载失败']);
const statusTexts = new Set(LYRIC_STATUS_TEXTS);

export function localizeLyricStatusText(text, translate) {
    return typeof text === 'string' && statusTexts.has(text) ? translate(text) : text;
}
