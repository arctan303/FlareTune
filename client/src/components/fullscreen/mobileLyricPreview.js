const NON_LYRIC_LINE_PATTERN = /^(暂无歌词|纯音乐[，,\s]*请欣赏|歌词加载失败)$/u;

export function getMobileLyricWindow(length, currentIndex, rowHeight) {
    const count = Math.max(0, Number.isInteger(length) ? length : 0);
    const index = Math.max(0, Math.min(Number.isInteger(currentIndex) ? currentIndex : 0, count - 1));
    const start = Math.max(0, index - 3);
    const end = Math.min(count, index + 4);
    return { start, end, beforeHeight: start * rowHeight, afterHeight: (count - end) * rowHeight };
}

export function getPrimaryLyricLine(lyric) {
    if (typeof lyric?.text !== 'string') return '';

    const line = lyric.text
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) || '';

    return NON_LYRIC_LINE_PATTERN.test(line) ? '' : line;
}

export function getTranslationLyricLine(lyric) {
    if (!lyric) return '';
    if (typeof lyric.translation === 'string' && lyric.translation.trim()) {
        const trans = lyric.translation.trim();
        return NON_LYRIC_LINE_PATTERN.test(trans) ? '' : trans;
    }
    if (typeof lyric.text === 'string') {
        const lines = lyric.text.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length > 1 && !NON_LYRIC_LINE_PATTERN.test(lines[1])) {
            return lines[1];
        }
    }
    return '';
}
