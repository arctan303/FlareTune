// Fast departure and a long, soft deceleration; never overshoot the target.
// Elapsed time keeps the curve consistent across displays.
export const CLASSIC_LYRIC_SCROLL_MS = 720;

export function classicLyricEase(progress) {
    const t = Math.max(0, Math.min(1, progress));
    return 1 - (1 - t) ** 4;
}
