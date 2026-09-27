export const getCenteredQueueScrollTop = ({
    itemTop,
    itemHeight,
    viewportHeight,
    scrollHeight,
}) => {
    const values = [itemTop, itemHeight, viewportHeight, scrollHeight].map(Number);
    if (!values.every(Number.isFinite)) return 0;

    const [safeItemTop, safeItemHeight, safeViewportHeight, safeScrollHeight] = values;
    if (safeViewportHeight <= 0 || safeScrollHeight <= 0) return 0;

    const maxScrollTop = Math.max(0, safeScrollHeight - safeViewportHeight);
    const centeredScrollTop = safeItemTop - ((safeViewportHeight - Math.max(0, safeItemHeight)) / 2);
    return Math.min(maxScrollTop, Math.max(0, centeredScrollTop));
};
