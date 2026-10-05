export const getSeekableLyricIndices = (lyrics) => lyrics.flatMap((line, index) => (
    Number.isFinite(line?.time) ? [index] : []
));

export function getLyricKeyboardTarget(indices, currentIndex, key) {
    if (!indices.length) return null;
    const position = Math.max(0, indices.indexOf(currentIndex));
    if (key === 'Home') return indices[0];
    if (key === 'End') return indices.at(-1);
    if (key === 'ArrowUp') return indices[Math.max(0, position - 1)];
    if (key === 'ArrowDown') return indices[Math.min(indices.length - 1, position + 1)];
    return null;
}
