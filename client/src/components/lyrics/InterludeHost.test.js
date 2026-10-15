import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./InterludeHost.jsx', import.meta.url), 'utf8');
const classicCss = readFileSync(new URL('../fullscreen/classic-player.css', import.meta.url), 'utf8');

test('InterludeHost consumes the shared playback clock without owning audio events or RAF', () => {
    assert.match(source, /import \{ lyricPlaybackClock \} from '\.\.\/\.\.\/services\/lyricPlaybackClock'/);
    assert.match(source, /lyricPlaybackClock\.getSnapshot\(\)/);
    assert.match(source, /lyricPlaybackClock\.subscribe\(updateFromClock, \{/);
    assert.match(source, /getNextBoundary:[\s\S]*getNextInterludeBoundary/);
    assert.match(source, /surfaceVisible\s*&&/);
    assert.doesNotMatch(source, /requestAnimationFrame|cancelAnimationFrame/);
    assert.doesNotMatch(source, /audio\.addEventListener|audio\.removeEventListener/);
});

test('InterludeHost passes one explicit sync mode to both state and dot window consumers', () => {
    assert.match(source, /syncMode = 'line'/);
    assert.match(source, /getInterludeState\(\{[\s\S]*?syncMode,[\s\S]*?\}\)/);
    assert.match(source, /getInterludeDotTimes\(\{[\s\S]*?syncMode,[\s\S]*?\}\)/);
});

test('InterludeHost keeps hidden dot buttons inert and uses one seek writer per click', () => {
    assert.match(source, /inert=\{isInterlude \? undefined : ''\}/);
    assert.match(source, /onSeekDot=\{isInterlude \? handleSeekDot : null\}/);
    assert.match(source, /if \(typeof onSeekTime === 'function'\) \{[\s\S]*?onSeekTime\(time\);[\s\S]*?\} else if \(audioRef\?\.current\) \{[\s\S]*?audioRef\.current\.currentTime = time;/);
    assert.equal(source.match(/\.currentTime = time/g)?.length, 1);
});

test('InterludeHost resets its retained stage immediately when the shared clock moves backward', () => {
    assert.match(source, /const rewound = currentTime \+ 0\.002 < lastClockTimeRef\.current/);
    assert.match(source, /if \(rewound\) lastActiveStageRef\.current = 0/);
    assert.match(source, /rewindRevision/);
});

test('candidate promotion derives the first painted state from the current shared snapshot', () => {
    const snapshotRead = source.indexOf(
        'const renderTime = snapshotTime(lyricPlaybackClock.getSnapshot())',
    );
    const effectStart = source.indexOf('useEffect(() =>');
    const renderState = source.indexOf('const renderInterludeState = isCandidate');
    const earlyReturn = source.indexOf('if (!isCandidate) return children;');

    assert.ok(snapshotRead >= 0 && snapshotRead < effectStart);
    assert.ok(renderState > effectStart && renderState < earlyReturn);
    assert.match(
        source,
        /const renderInterludeState = isCandidate[\s\S]*?currentTime: renderTime/,
    );
    assert.match(source, /const isInterlude = renderInterludeState\.isInterlude/);
    assert.match(
        source,
        /displayStage = isInterlude\s*\? renderInterludeState\.stage/,
    );
    assert.doesNotMatch(source, /const isInterlude = interludeState\.isInterlude/);
});

test('interlude progress keeps its normal scale and breathing without a system override', () => {
    const dots = readFileSync(new URL('./interlude-dots.css', import.meta.url), 'utf8');
    assert.doesNotMatch(classicCss + dots, /prefers-reduced-motion/);
    assert.match(dots, /apple-interlude-heartbeat/);
    assert.match(dots, /data-motion-running='true'/);
});
