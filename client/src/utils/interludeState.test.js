import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getInterludeState,
    isInterludeActive,
    getLyricSingDuration,
    getInterludeDotTimes,
    INTERLUDE_CONFIG,
    resolveInterludeWindow,
    getNextInterludeBoundary,
} from './interludeState.js';
import { findActiveLyricLineIndex } from './lyricTimeline.js';

test('boundary scheduling visits interlude entry, every dot stage and exit without continuous frames', () => {
    const lyrics = [{ time: 0, endTime: 4, text: 'First' }, { time: 24, endTime: 26, text: 'Second' }];
    const params = { lyrics, currentLyricIndex: 0, lineIndex: 0, syncMode: 'line', currentTime: 0 };
    const states = [];
    for (let index = 0; index < 5; index += 1) {
        const next = getNextInterludeBoundary(params);
        assert.ok(next > params.currentTime);
        params.currentTime = next;
        const state = getInterludeState(params);
        states.push([state.isInterlude, state.stage]);
    }
    assert.deepEqual(states, [[true, 0], [true, 1], [true, 2], [true, 3], [false, 0]]);
    assert.equal(getNextInterludeBoundary({ ...params, isUserScrolling: true }), null);
});

test('getLyricSingDuration: scales proportionally with character count', () => {
    const shortDur = getLyricSingDuration('你好', 12);
    const longDur = getLyricSingDuration('这是一句非常长而且有很多字数的经典歌词', 12);

    assert.ok(shortDur < longDur);
    assert.ok(shortDur >= 2.0);
    assert.ok(longDur <= 12 * 0.55);
});

test('getInterludeState: accurately follows milestone checkpoints (0% ○○○, 33% ●○○, 66% ●●○, 100% ●●●) and returns to lyrics in final handover', () => {
    const text = '天青色等烟雨';
    const lyrics = [
        { time: 10, text },
        { time: 40, text: '炊烟袅袅升起' }, // gap = 30s, next line at 40s
    ];

    const singDur = getLyricSingDuration(text, 30);
    const dotsStart = 10 + singDur;
    const dotsEnd = 40 - INTERLUDE_CONFIG.RETURN_LEAD_TIME;
    const totalDotsTime = dotsEnd - dotsStart;

    // 1. 起步阶段 (例如 15% 进度 < 33.3%) -> Stage 0 (三点全暗 ○ ○ ○)
    const s0 = getInterludeState({
        currentTime: dotsStart + totalDotsTime * 0.15,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
    });
    assert.equal(s0.isInterlude, true);
    assert.equal(s0.stage, 0);

    // 2. 满 1/3 进度 (例如 45% 进度) -> Stage 1 (点亮第 1 颗 ● ○ ○)
    const s1 = getInterludeState({
        currentTime: dotsStart + totalDotsTime * 0.45,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
    });
    assert.equal(s1.isInterlude, true);
    assert.equal(s1.stage, 1);

    // 3. 满 2/3 进度 (例如 75% 进度) -> Stage 2 (点亮第 2 颗 ● ● ○)
    const s2 = getInterludeState({
        currentTime: dotsStart + totalDotsTime * 0.75,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
    });
    assert.equal(s2.isInterlude, true);
    assert.equal(s2.stage, 2);

    // 4. 100% 冲线到达 (例如 38.0s，距离 dotsEnd 还有 0.2s) -> Stage 3 (三点全亮 ● ● ●)
    const s3 = getInterludeState({
        currentTime: dotsEnd - 0.2,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
    });
    assert.equal(s3.isInterlude, true);
    assert.equal(s3.stage, 3);

    // 5. 进入最后交接期 (例如 39.5s) -> isInterlude 变回 false，让歌词平滑显现就位
    const sEnd = getInterludeState({
        currentTime: 39.5,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
    });
    assert.equal(sEnd.isInterlude, false);
});

test('getInterludeDotTimes: calculates precise seek targets corresponding to stages 1, 2, and 3', () => {
    const text = '天青色等烟雨';
    const lyrics = [
        { time: 10, text },
        { time: 40, text: '炊烟袅袅升起' }, // gap = 30s
    ];

    const times = getInterludeDotTimes({
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
    });

    assert.ok(times);
    assert.ok(times.t1 < times.t2);
    assert.ok(times.t2 < times.t3);

    // 验证跳转到 t1 时状态刚好为 Stage 1
    const s1 = getInterludeState({
        currentTime: times.t1,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
    });
    assert.equal(s1.isInterlude, true);
    assert.equal(s1.stage, 1);

    // 验证跳转到 t2 时状态刚好为 Stage 2
    const s2 = getInterludeState({
        currentTime: times.t2,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
    });
    assert.equal(s2.isInterlude, true);
    assert.equal(s2.stage, 2);

    // 验证跳转到 t3 时状态刚好为 Stage 3 (冲线全亮)
    const s3 = getInterludeState({
        currentTime: times.t3,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
    });
    assert.equal(s3.isInterlude, true);
    assert.equal(s3.stage, 3);
});

test('isInterludeActive: stays false while singing, then recovers on user scroll', () => {
    const lyrics = [
        { time: 10, text: '第一句' },
        { time: 30, text: '第二句' },
    ];

    // 演唱中 -> false
    assert.equal(isInterludeActive({
        currentTime: 11,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
    }), false);

    // 间奏中 -> true
    assert.equal(isInterludeActive({
        currentTime: 20,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
        isUserScrolling: false,
    }), true);

    // 用户滚动中 -> 强制 false 恢复歌词
    assert.equal(isInterludeActive({
        currentTime: 20,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
        isUserScrolling: true,
    }), false);
});

test('interlude triggers: rejects gaps < 12.0s and active windows < 4.0s to prevent accidental triggers', () => {
    // 1. 普通停顿（例如 8.0s ~ 11.0s），绝不再误触发间奏
    const lyricsModerateGap = [
        { time: 10, text: '这是一句抒情歌词' },
        { time: 19, text: '这是下一句歌词' }, // gap = 9.0s (< 12.0s)
    ];

    // 在 10s ~ 19s 的任意时间点，均保持 false
    for (let t = 10; t < 19; t += 1.5) {
        const state = getInterludeState({
            currentTime: t,
            lyrics: lyricsModerateGap,
            currentLyricIndex: 0,
            lineIndex: 0,
        });
        assert.equal(state.isInterlude, false, `Time ${t}s in 9s gap should not trigger interlude`);
    }
    assert.equal(getInterludeDotTimes({
        lyrics: lyricsModerateGap,
        currentLyricIndex: 0,
        lineIndex: 0,
    }), null);

    // 2. 短前奏（例如 8.0s、10.0s）绝不再触发前奏指示器
    const lyricsShortIntro = [
        { time: 9.0, text: '第一句歌词' }, // intro = 9.0s (< 12.0s)
        { time: 25.0, text: '第二句歌词' },
    ];
    for (let t = 0; t < 9.0; t += 1.5) {
        const state = getInterludeState({
            currentTime: t,
            lyrics: lyricsShortIntro,
            currentLyricIndex: 0,
            lineIndex: 0,
        });
        assert.equal(state.isInterlude, false, `Intro time ${t}s for 9s intro should not trigger interlude`);
    }

    // 3. 即使 gap >= 12.0s，但纯指示器净时间不足 4.0s 时，杜绝仓促闪烁
    // 例如 gap = 12.0s，但长文本歌词占用了 6.6s，加交接 1.8s 后剩余 3.6s (< 4.0s)
    const longText = '这是一段非常非常非常非常长而且密集的说唱歌词需要唱很久很久很久很久很久很久很久';
    const lyricsTightWindow = [
        { time: 10, text: longText },
        { time: 22, text: '下一句' }, // gap = 12.0s
    ];
    const singDur = getLyricSingDuration(longText, 12.0); // capped at 6.6s
    const activeWindow = (22 - 1.8) - (10 + singDur); // 3.6s < 4.0s
    assert.ok(activeWindow < INTERLUDE_CONFIG.MIN_ACTIVE_SECONDS);

    const stateTight = getInterludeState({
        currentTime: 10 + singDur + 1.0,
        lyrics: lyricsTightWindow,
        currentLyricIndex: 0,
        lineIndex: 0,
    });
    assert.equal(stateTight.isInterlude, false);
    assert.equal(getInterludeDotTimes({
        lyrics: lyricsTightWindow,
        currentLyricIndex: 0,
        lineIndex: 0,
    }), null);
});

test('getInterludeDotTimes: differentiates long intro from line-0 interlude via currentTime', () => {
    const lyrics = [
        { time: 15.0, text: '第一句开唱' }, // intro = 15.0s (>= 12.0s)
        { time: 45.0, text: '第二句开唱' }, // gap = 30.0s (>= 12.0s)
    ];

    // 前奏阶段（currentTime = 5.0s < 15.0s）
    const introDots = getInterludeDotTimes({
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
        currentTime: 5.0,
    });
    assert.ok(introDots);
    assert.ok(introDots.t3 < 15.0); // 前奏点必须在 15.0s 之前

    // 行间间奏阶段（currentTime = 25.0s >= 15.0s）
    const interludeDots = getInterludeDotTimes({
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
        currentTime: 25.0,
    });
    assert.ok(interludeDots);
    assert.ok(interludeDots.t1 > 15.0); // 行间点必须在第 1 句（15.0s）之后
    assert.ok(interludeDots.t3 < 45.0); // 行间点必须在第 2 句（45.0s）之前
});

test('resolveInterludeWindow: exact word boundaries enable a short-gap interlude only after the final vocal word', () => {
    const lyrics = [
        {
            time: 10,
            endTime: 13,
            text: '唱完这一句',
            words: [
                { text: '唱完', startTime: 10, endTime: 11.5 },
                { text: '这一句', startTime: 11.5, endTime: 13 },
                { text: '   ', startTime: 13, endTime: 99 },
            ],
        },
        {
            time: 20,
            text: '下一句',
            words: [{ text: '下一句', startTime: 20, endTime: 21 }],
        },
    ];
    const window = resolveInterludeWindow({
        currentTime: 15,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'word',
    });
    assert.deepEqual(window, {
        kind: 'between-lines',
        basis: 'exact',
        start: 13,
        end: 18.2,
        duration: 5.199999999999999,
        diagnosticReason: null,
    });
    assert.equal(getInterludeState({
        currentTime: 12.999,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'word',
    }).isInterlude, false);
    assert.equal(getInterludeState({
        currentTime: 13,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'word',
    }).isInterlude, true);

    const dots = getInterludeDotTimes({
        currentTime: 15,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'word',
    });
    assert.equal(dots.t1, window.start + (window.duration / 3) + 0.05);
    assert.equal(dots.t2, window.start + (window.duration * 2 / 3) + 0.05);
    assert.ok(dots.t3 < window.end);
});

test('word activation waits for the next vocal start so exact interlude is not truncated by an early line timestamp', () => {
    const lyrics = [
        {
            time: 10,
            endTime: 13,
            text: 'first',
            words: [{ text: 'first', startTime: 10, endTime: 13 }],
        },
        {
            time: 14,
            endTime: 21,
            text: 'second',
            words: [{ text: 'second', startTime: 20, endTime: 21 }],
        },
    ];
    const activeIndex = findActiveLyricLineIndex(lyrics, 15, 'word');
    assert.equal(activeIndex, 0);
    assert.equal(getInterludeState({
        currentTime: 15,
        lyrics,
        currentLyricIndex: activeIndex,
        lineIndex: activeIndex,
        syncMode: 'word',
    }).isInterlude, true);
});

test('malformed overlapping word axes never make an exact interlude start before a reliable line end', () => {
    const lyrics = [
        {
            time: 10,
            endTime: 18,
            text: 'AB',
            words: [
                { text: 'A', startTime: 10, endTime: 18 },
                { text: 'B', startTime: 12, endTime: 13 },
            ],
        },
        {
            time: 25,
            text: 'C',
            words: [{ text: 'C', startTime: 25, endTime: 26 }],
        },
    ];
    const window = resolveInterludeWindow({
        currentTime: 14,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'word',
    });
    assert.equal(window.start, 18);
    assert.equal(getInterludeState({
        currentTime: 14,
        lyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'word',
    }).isInterlude, false);
});

test('resolveInterludeWindow: explicit line end and local words stay exact in a globally line-degraded document', () => {
    const explicitEnd = resolveInterludeWindow({
        currentTime: 12,
        lyrics: [
            { time: 10, endTime: 11, text: '短句' },
            { time: 17, text: '下一句' },
        ],
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'line',
    });
    assert.equal(explicitEnd.basis, 'exact');
    assert.equal(explicitEnd.start, 11);
    assert.equal(explicitEnd.end, 15.2);

    const localWords = resolveInterludeWindow({
        currentTime: 15,
        lyrics: [
            { time: 10, text: '局部精确', words: [{ text: '局部精确', startTime: 10, endTime: 13 }] },
            { time: 20, text: '降级行' },
            { time: 21, text: '导致全歌 line' },
        ],
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'line',
    });
    assert.equal(localWords.basis, 'exact');
    assert.equal(localWords.start, 13);
});

test('resolveInterludeWindow: word mode never estimates missing exact timing and exact short windows never fall back', () => {
    const wordUnavailable = resolveInterludeWindow({
        currentTime: 20,
        lyrics: [
            { time: 10, text: '缺少结束轴' },
            { time: 40, text: '下一句' },
        ],
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'word',
    });
    assert.deepEqual(wordUnavailable, {
        kind: 'between-lines',
        basis: 'none',
        start: null,
        end: null,
        duration: 0,
        diagnosticReason: 'exact-unavailable',
    });

    const exactTooShort = resolveInterludeWindow({
        currentTime: 20,
        lyrics: [
            { time: 10, endTime: 27, text: '实际一直唱到很晚' },
            { time: 30, text: '下一句' },
        ],
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'line',
    });
    assert.equal(exactTooShort.basis, 'none');
    assert.equal(exactTooShort.diagnosticReason, 'exact-window-too-short');
});

test('resolveInterludeWindow: intro uses exact word timing at four seconds while line-only keeps twelve seconds', () => {
    const exactLyrics = [{
        time: 6,
        text: '第一句',
        words: [{ text: '第一句', startTime: 6, endTime: 7 }],
    }];
    const exactIntro = resolveInterludeWindow({
        currentTime: 2,
        lyrics: exactLyrics,
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'line',
    });
    assert.deepEqual(exactIntro, {
        kind: 'intro',
        basis: 'exact',
        start: 0,
        end: 4,
        duration: 4,
        diagnosticReason: null,
    });
    assert.equal(exactLyrics.length, 1, 'intro resolution must not fabricate a lyric line');

    const shortLineOnly = resolveInterludeWindow({
        currentTime: 2,
        lyrics: [{ time: 9, text: '第一句' }],
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'line',
    });
    assert.equal(shortLineOnly.basis, 'none');
    assert.equal(shortLineOnly.diagnosticReason, 'line-only-intro-below-threshold');

    const longLineOnly = resolveInterludeWindow({
        currentTime: 2,
        lyrics: [{ time: 15, text: '第一句' }],
        currentLyricIndex: 0,
        lineIndex: 0,
        syncMode: 'line',
    });
    assert.equal(longLineOnly.basis, 'exact');
    assert.equal(longLineOnly.end, 13);
});
