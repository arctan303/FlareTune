import test from 'node:test';
import assert from 'node:assert/strict';
import {
    findActiveLyricLineIndex,
    getReliableLyricWordBounds,
    getNextLyricBoundary,
    resolveLineWordProgress,
    resolveLyricTimelineSnapshot,
    segmentLyricGraphemes,
} from './lyricTimeline.js';

const makeLine = (time, words, extra = {}) => ({
    time,
    text: words?.map((word) => word.text).join('') || '',
    words,
    ...extra,
});

test('findActiveLyricLineIndex uses canonical index zero before the first line and binary upper-bound semantics', () => {
    const lines = [
        { time: 5, text: 'first' },
        { time: 10, text: 'second-a' },
        { time: 10, text: 'second-b' },
        { time: 20, text: 'third' },
    ];

    assert.equal(findActiveLyricLineIndex([], 1), -1);
    assert.equal(findActiveLyricLineIndex(lines, 0), 0);
    assert.equal(findActiveLyricLineIndex(lines, 5), 0);
    assert.equal(findActiveLyricLineIndex(lines, 9.999), 0);
    assert.equal(findActiveLyricLineIndex(lines, 10), 2);
    assert.equal(findActiveLyricLineIndex(lines, 19), 2);
    assert.equal(findActiveLyricLineIndex(lines, 99), 3);
});

test('line lookup is independent of seek direction', () => {
    const lines = [0, 4, 8, 12].map((time) => ({ time, text: String(time) }));
    const seeks = [0, 11, 3, 12, 7, 4, 0];
    assert.deepEqual(
        seeks.map((time) => findActiveLyricLineIndex(lines, time)),
        [0, 2, 0, 3, 1, 1, 0],
    );
});

test('word mode keeps the previous line active until the next real vocal starts', () => {
    const lines = [
        makeLine(10, [{ text: 'first', startTime: 10, endTime: 13 }], { endTime: 13 }),
        makeLine(14, [{ text: 'second', startTime: 20, endTime: 21 }], { endTime: 21 }),
    ];

    assert.equal(findActiveLyricLineIndex(lines, 15, 'line'), 1);
    assert.equal(findActiveLyricLineIndex(lines, 15, 'word'), 0);
    assert.equal(findActiveLyricLineIndex(lines, 20, 'word'), 1);
});

test('word progress is continuous within a word and holds during gaps', () => {
    const line = makeLine(1, [
        { text: 'ab', startTime: 1, endTime: 3 },
        { text: ' ', startTime: 4, endTime: 5 },
        { text: '界', startTime: 5, endTime: 7 },
    ]);

    assert.deepEqual(resolveLineWordProgress(line, 0.5), {
        activeWordIndex: -1,
        wordProgress: 0,
        lineProgress: 0,
        hasStarted: false,
        isComplete: false,
        hasWordTiming: true,
    });
    assert.deepEqual(resolveLineWordProgress(line, 2), {
        activeWordIndex: 0,
        wordProgress: 0.5,
        lineProgress: 0.25,
        hasStarted: true,
        isComplete: false,
        hasWordTiming: true,
    });
    assert.deepEqual(resolveLineWordProgress(line, 3.5), {
        activeWordIndex: 0,
        wordProgress: 1,
        lineProgress: 0.5,
        hasStarted: true,
        isComplete: false,
        hasWordTiming: true,
    });
    assert.deepEqual(resolveLineWordProgress(line, 6), {
        activeWordIndex: 2,
        wordProgress: 0.5,
        lineProgress: 0.875,
        hasStarted: true,
        isComplete: false,
        hasWordTiming: true,
    });
    assert.deepEqual(resolveLineWordProgress(line, 7), {
        activeWordIndex: 2,
        wordProgress: 1,
        lineProgress: 1,
        hasStarted: true,
        isComplete: true,
        hasWordTiming: true,
    });
});

test('repeated starts select the last started word and zero-duration words complete discretely', () => {
    const line = makeLine(2, [
        { text: 'A', startTime: 2, endTime: 2 },
        { text: 'B', startTime: 2, endTime: 3 },
        { text: 'C', startTime: 4, endTime: 4 },
    ]);

    assert.deepEqual(resolveLineWordProgress(line, 2), {
        activeWordIndex: 1,
        wordProgress: 0,
        lineProgress: 1 / 3,
        hasStarted: true,
        isComplete: false,
        hasWordTiming: true,
    });
    assert.deepEqual(resolveLineWordProgress(line, 3.5), {
        activeWordIndex: 1,
        wordProgress: 1,
        lineProgress: 2 / 3,
        hasStarted: true,
        isComplete: false,
        hasWordTiming: true,
    });
    assert.deepEqual(resolveLineWordProgress(line, 4), {
        activeWordIndex: 2,
        wordProgress: 1,
        lineProgress: 1,
        hasStarted: true,
        isComplete: true,
        hasWordTiming: true,
    });
});

test('grapheme weighting keeps whitespace and treats emoji or combining sequences as one segment', () => {
    assert.deepEqual(segmentLyricGraphemes('A B'), ['A', ' ', 'B']);
    assert.equal(segmentLyricGraphemes('e\u0301').length, 1);
    assert.equal(segmentLyricGraphemes('👨‍👩‍👧‍👦').length, 1);
    assert.deepEqual(segmentLyricGraphemes('e\u0301', null), ['e', '\u0301']);

    const line = makeLine(0, [
        { text: '👨‍👩‍👧‍👦', startTime: 0, endTime: 1 },
        { text: ' ', startTime: 1, endTime: 2 },
        { text: 'e\u0301', startTime: 2, endTime: 3 },
    ]);
    assert.equal(resolveLineWordProgress(line, 1.5).lineProgress, 0.5);
});

test('missing or malformed word axes degrade safely to a static line', () => {
    const malformed = [
        null,
        { time: 0, text: 'none' },
        makeLine(0, []),
        makeLine(0, [{ text: 'x', startTime: -1, endTime: 1 }]),
        makeLine(0, [{ text: 'x', startTime: 2, endTime: 1 }]),
        makeLine(0, [
            { text: 'x', startTime: 2, endTime: 3 },
            { text: 'y', startTime: 1, endTime: 4 },
        ]),
        makeLine(0, [
            { text: 'x', startTime: 0, endTime: 3 },
            { text: 'y', startTime: 2, endTime: 2.5 },
        ]),
        makeLine(2, [{ text: 'x', startTime: 1, endTime: 3 }]),
        makeLine(0, [{ text: 'x', startTime: 0, endTime: 3 }], { endTime: 2 }),
        makeLine(0, [{ text: '', startTime: 0, endTime: 1 }]),
        makeLine(0, [
            { text: 'x', startTime: 0, endTime: 1 },
            { text: '', startTime: 1, endTime: 2 },
        ]),
    ];

    for (const line of malformed) {
        assert.deepEqual(resolveLineWordProgress(line, 2), {
            activeWordIndex: -1,
            wordProgress: 0,
            lineProgress: 0,
            hasStarted: false,
            isComplete: false,
            hasWordTiming: false,
        });
    }

    assert.equal(getReliableLyricWordBounds(malformed[6]), null);
});

test('snapshot exposes prelude state separately from canonical active index', () => {
    const lines = [
        makeLine(5, [{ text: 'start', startTime: 5, endTime: 6 }]),
        { time: 10, endTime: 12, text: 'line only' },
    ];

    const before = resolveLyricTimelineSnapshot({ lines, currentTime: 2 });
    assert.equal(before.activeLineIndex, 0);
    assert.equal(before.activeLine, lines[0]);
    assert.equal(before.hasStarted, false);
    assert.equal(before.lineProgress, 0);

    const lineOnly = resolveLyricTimelineSnapshot({ lines, currentTime: 11 });
    assert.equal(lineOnly.activeLineIndex, 1);
    assert.equal(lineOnly.hasWordTiming, false);
    assert.equal(lineOnly.hasStarted, true);
    assert.equal(lineOnly.isComplete, false);

    const complete = resolveLyricTimelineSnapshot({ lines, currentTime: 12 });
    assert.equal(complete.isComplete, true);
});

test('snapshot handles empty input and invalid current time without throwing', () => {
    assert.deepEqual(resolveLyricTimelineSnapshot({ lines: [], currentTime: Number.NaN }), {
        currentTime: 0,
        activeLineIndex: -1,
        activeLine: null,
        activeWordIndex: -1,
        wordProgress: 0,
        lineProgress: 0,
        hasStarted: false,
        isComplete: false,
        hasWordTiming: false,
    });
});

test('repeated timeline samples reuse grapheme weights and refresh changed word timing or text', () => {
    const nativeSegment = Intl.Segmenter.prototype.segment;
    let segmentCalls = 0;
    Intl.Segmenter.prototype.segment = function (text) {
        segmentCalls += 1;
        return nativeSegment.call(this, text);
    };
    try {
        const line = makeLine(0, [
            { text: 'A', startTime: 0, endTime: 1 },
            { text: 'B', startTime: 1, endTime: 2 },
        ], { endTime: 3 });
        for (let sample = 0; sample < 120; sample += 1) {
            assert.equal(findActiveLyricLineIndex([line], 0.5, 'word'), 0);
            assert.equal(resolveLineWordProgress(line, 0.5).lineProgress, 0.25);
            assert.deepEqual(getReliableLyricWordBounds(line), { startTime: 0, endTime: 2 });
        }
        assert.equal(segmentCalls, 2, 'unchanged samples must not re-segment the words');

        line.words[1].text = 'BC';
        assert.equal(resolveLineWordProgress(line, 0.5).lineProgress, 1 / 6);
        line.words[1].endTime = 3;
        assert.deepEqual(getReliableLyricWordBounds(line), { startTime: 0, endTime: 3 });
        line.words[0].startTime = 0.25;
        assert.equal(resolveLineWordProgress(line, 0).hasStarted, false);
        assert.deepEqual(getReliableLyricWordBounds(line), { startTime: 0.25, endTime: 3 });
        assert.equal(segmentCalls, 8);
    } finally {
        Intl.Segmenter.prototype.segment = nativeSegment;
    }
});

test('cached axes respect line bounds, array edits, invalid repairs and independent returned bounds', () => {
    const line = makeLine(0, [{ text: 'A', startTime: 0, endTime: 1 }], { endTime: 3 });
    const bounds = getReliableLyricWordBounds(line);
    bounds.endTime = 99;
    assert.deepEqual(getReliableLyricWordBounds(line), { startTime: 0, endTime: 1 });

    line.time = 0.5;
    assert.equal(resolveLineWordProgress(line, 0.75).hasWordTiming, false);
    line.time = 0;
    line.endTime = 0.5;
    assert.equal(resolveLineWordProgress(line, 0.25).hasWordTiming, false);
    line.endTime = 3;
    line.words.push({ text: 'B', startTime: 1, endTime: 2 });
    assert.equal(resolveLineWordProgress(line, 1.5).lineProgress, 0.75);
    line.words[1].startTime = 0.5;
    assert.equal(resolveLineWordProgress(line, 1.5).hasWordTiming, false);
    line.words[1] = { text: 'B', startTime: 1, endTime: 2 };
    assert.equal(resolveLineWordProgress(line, 1.5).hasWordTiming, true);
    line.words = [{ text: 'C', startTime: 2, endTime: 3 }];
    assert.deepEqual(getReliableLyricWordBounds(line), { startTime: 2, endTime: 3 });
    const shifted = { ...line, time: 4, endTime: 5,
        words: [{ text: 'C', startTime: 4, endTime: 5 }] };
    assert.deepEqual(getReliableLyricWordBounds(shifted), { startTime: 4, endTime: 5 });
    assert.deepEqual(getReliableLyricWordBounds(line), { startTime: 2, endTime: 3 });
});

test('next lyric boundary follows intro vocals, line activation and completion without sampling intermediate seconds', () => {
    const lines = [
        makeLine(5, [{ text: 'First', startTime: 6.125, endTime: 8.25 }], { endTime: 8.5 }),
        makeLine(9, [{ text: 'Second', startTime: 11.75, endTime: 12.5 }], { endTime: 12.5 }),
    ];
    assert.equal(getNextLyricBoundary(lines, 0, 'word'), 6.125);
    assert.equal(getNextLyricBoundary(lines, 6.125, 'word'), 8.25);
    assert.equal(getNextLyricBoundary(lines, 8.5, 'word'), 11.75);
    assert.equal(getNextLyricBoundary(lines, 8.5, 'line'), 9);
    assert.equal(getNextLyricBoundary(lines, 12.5, 'word'), null);
    assert.equal(getNextLyricBoundary([], 0, 'word'), null);
});
