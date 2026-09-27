import test from 'node:test';
import assert from 'node:assert/strict';
import {
    IMMERSIVE_LYRIC_ACTIONS,
    IMMERSIVE_LYRIC_TRANSITIONS,
    createImmersiveLyricState,
    getImmersiveLyricIdentity,
    reduceImmersiveLyricState,
} from './immersiveLyricState.js';

const syncAction = (overrides = {}) => {
    const lineIndex = overrides.lineIndex ?? 0;
    const kind = overrides.kind ?? 'line';
    const text = overrides.text ?? `line-${lineIndex}`;
    const translation = overrides.translation ?? '';
    const line = overrides.line ?? { text, translation };
    return {
        type: IMMERSIVE_LYRIC_ACTIONS.SYNC,
        songKey: 'song-a|audio-a',
        effectId: 'drift',
        transition: IMMERSIVE_LYRIC_TRANSITIONS.SYNC,
        presentation: { kind, index: lineIndex, line },
        lineIndex,
        line,
        text,
        translation,
        ...overrides,
    };
};

const present = (state, overrides) => reduceImmersiveLyricState(
    state,
    syncAction(overrides),
);

test('identity uses songKey, presentation kind and line index instead of content', () => {
    const base = {
        songKey: 'song-a|audio-a',
        presentation: { kind: 'line', index: 0 },
        lineIndex: 0,
    };
    assert.equal(
        getImmersiveLyricIdentity(base),
        getImmersiveLyricIdentity({ ...base, text: 'different content' }),
    );
    assert.notEqual(
        getImmersiveLyricIdentity(base),
        getImmersiveLyricIdentity({ ...base, songKey: 'song-b|audio-b' }),
    );
    assert.notEqual(
        getImmersiveLyricIdentity(base),
        getImmersiveLyricIdentity({
            ...base,
            presentation: { kind: 'intro', index: 0 },
        }),
    );
    assert.notEqual(
        getImmersiveLyricIdentity(base),
        getImmersiveLyricIdentity({
            ...base,
            presentation: { kind: 'line', index: 1 },
            lineIndex: 1,
        }),
    );
});

test('ordinary adjacent forward line transition creates exactly one bounded exit', () => {
    let state = createImmersiveLyricState(syncAction());
    state = present(state, {
        lineIndex: 1,
        transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        animateEntry: true,
        exitAnimationName: 'lyric-drift-exit',
    });

    assert.equal(state.active.lineIndex, 1);
    assert.equal(state.active.animateEntry, true);
    assert.equal(state.exiting.lineIndex, 0);
    assert.equal(state.exiting.animateEntry, false);
    assert.equal(state.exiting.token, 1);
    assert.equal(state.exiting.animationName, 'lyric-drift-exit');
    assert.equal(state.nextExitToken, 2);

    state = present(state, {
        lineIndex: 2,
        transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        animateEntry: true,
        exitAnimationName: 'lyric-drift-exit',
    });
    assert.equal(state.active.lineIndex, 2);
    assert.equal(state.exiting.lineIndex, 1);
    assert.equal(state.exiting.token, 2);
    assert.equal(state.nextExitToken, 3);
    assert.equal(Array.isArray(state.exiting), false);
});

test('same-line content and translation updates replace references without creating or replaying layers', () => {
    let state = createImmersiveLyricState(syncAction());
    state = present(state, {
        lineIndex: 1,
        transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        animateEntry: true,
        exitAnimationName: 'lyric-drift-exit',
    });
    const existingExit = state.exiting;
    const updatedLine = { text: 'line-1', translation: '新的译文' };

    state = present(state, {
        lineIndex: 1,
        line: updatedLine,
        text: updatedLine.text,
        translation: updatedLine.translation,
        transition: IMMERSIVE_LYRIC_TRANSITIONS.CONTENT,
        animateEntry: true,
    });

    assert.strictEqual(state.active.line, updatedLine);
    assert.equal(state.active.text, 'line-1');
    assert.equal(state.active.translation, '新的译文');
    assert.equal(state.active.animateEntry, false);
    assert.strictEqual(state.exiting, existingExit);
    assert.equal(state.nextExitToken, 2);
});

test('entry animation is opt-in for a new advance identity and never replays on same-line sync', () => {
    let state = createImmersiveLyricState(syncAction({
        transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        animateEntry: true,
    }));
    assert.equal(state.active.animateEntry, true);

    state = present(state, {
        lineIndex: 0,
        transition: IMMERSIVE_LYRIC_TRANSITIONS.SYNC,
        animateEntry: true,
    });
    assert.equal(state.active.animateEntry, false);
    assert.equal(state.exiting, null);

    state = present(state, {
        lineIndex: 1,
        transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        animateEntry: false,
        exitAnimationName: 'lyric-drift-exit',
    });
    assert.equal(state.active.animateEntry, false);
    assert.ok(state.exiting);
});

test('only same-song adjacent line advances are allowed to exit', () => {
    const cases = [
        ['seek', {}, { lineIndex: 1, transition: IMMERSIVE_LYRIC_TRANSITIONS.SEEK }],
        ['unclassified adjacent update', {}, { lineIndex: 1 }],
        ['multi-line jump', {}, {
            lineIndex: 2,
            transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        }],
        ['backward jump', { lineIndex: 1 }, {
            lineIndex: 0,
            transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        }],
        ['song change', {}, {
            songKey: 'song-b|audio-b',
            lineIndex: 1,
            transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        }],
        ['loading', {}, {
            lineIndex: 1,
            transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
            loading: true,
        }],
        ['hidden', {}, {
            lineIndex: 1,
            transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
            visible: false,
        }],
        ['reduced motion', {}, {
            lineIndex: 1,
            transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
            reducedMotion: true,
        }],
    ];

    for (const [label, initialAction, action] of cases) {
        const initial = createImmersiveLyricState(syncAction(initialAction));
        const next = present(initial, { animateEntry: true, ...action });
        assert.equal(next.exiting, null, label);
        assert.equal(next.active?.animateEntry ?? false, false, `${label} entry`);
    }
});

test('cross-effect adjacent line advance creates exit layer with previous effect and entry with new effect', () => {
    let state = createImmersiveLyricState(syncAction({
        effectId: 'drift',
        lineIndex: 0,
    }));
    state = present(state, {
        effectId: 'wind',
        lineIndex: 1,
        transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        animateEntry: true,
        exitAnimationName: (previous) => `exit-${previous.effectId}`,
    });

    assert.equal(state.active.lineIndex, 1);
    assert.equal(state.active.effectId, 'wind');
    assert.equal(state.active.animateEntry, true);
    assert.ok(state.exiting);
    assert.equal(state.exiting.lineIndex, 0);
    assert.equal(state.exiting.effectId, 'drift');
    assert.equal(state.exiting.animationName, 'exit-drift');
});

test('intro and line zero remain distinct and never synthesize a line-to-line exit', () => {
    const intro = createImmersiveLyricState(syncAction({ kind: 'intro', lineIndex: 0 }));
    const line = present(intro, {
        kind: 'line',
        lineIndex: 0,
        transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        animateEntry: true,
    });
    assert.notEqual(intro.active.identity, line.active.identity);
    assert.equal(line.exiting, null);
    assert.equal(line.active.animateEntry, false);
});

test('suppression events clear an already-running exit without replaying the active entry', () => {
    const buildExitingState = () => present(
        createImmersiveLyricState(syncAction()),
        {
            lineIndex: 1,
            transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
            animateEntry: true,
            exitAnimationName: 'lyric-drift-exit',
        },
    );
    const cases = [
        ['seek', { lineIndex: 1, transition: IMMERSIVE_LYRIC_TRANSITIONS.SEEK }],
        ['multi-line jump', {
            lineIndex: 4,
            transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        }],
        ['backward jump', {
            lineIndex: 0,
            transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        }],
        ['song change', { lineIndex: 1, songKey: 'song-b|audio-b' }],
        ['effect change', { lineIndex: 1, effectId: 'wind' }],
        ['loading', { lineIndex: 1, loading: true }],
        ['hidden', { lineIndex: 1, visible: false }],
        ['reduced motion', { lineIndex: 1, reducedMotion: true }],
    ];

    for (const [label, action] of cases) {
        const next = present(buildExitingState(), action);
        assert.equal(next.exiting, null, label);
        assert.equal(next.active?.animateEntry ?? false, false, `${label} entry`);
    }
});

test('animation end must match token, layer identity and animation name', () => {
    let state = present(createImmersiveLyricState(syncAction()), {
        lineIndex: 1,
        transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        exitAnimationName: 'lyric-drift-exit',
    });
    const { token, identity, animationName } = state.exiting;

    for (const stale of [
        { token: token - 1, identity, animationName },
        { token, identity: 'stale-layer', animationName },
        { token, identity, animationName: 'child-word-animation' },
    ]) {
        const unchanged = reduceImmersiveLyricState(state, {
            type: IMMERSIVE_LYRIC_ACTIONS.ANIMATION_END,
            ...stale,
        });
        assert.strictEqual(unchanged, state);
        assert.ok(unchanged.exiting);
    }

    state = reduceImmersiveLyricState(state, {
        type: IMMERSIVE_LYRIC_ACTIONS.ANIMATION_END,
        token,
        identity,
        animationName,
    });
    assert.equal(state.exiting, null);
});

test('presentation index wins conflicts and an unnamed exit fails closed', () => {
    const line = { text: 'precise line', translation: '' };
    const staleLine = { text: 'stale low-frequency line', translation: '' };
    const mismatchedAction = {
        ...syncAction({ lineIndex: 0 }),
        presentation: { kind: 'line', index: 1, line },
        lineIndex: 0,
        line: staleLine,
        text: line.text,
    };
    const initial = createImmersiveLyricState(mismatchedAction);
    assert.equal(initial.active.lineIndex, 1);
    assert.strictEqual(initial.active.line, line);
    assert.equal(
        initial.active.identity,
        getImmersiveLyricIdentity({
            songKey: mismatchedAction.songKey,
            presentation: mismatchedAction.presentation,
            lineIndex: 0,
        }),
    );

    const next = present(initial, {
        lineIndex: 2,
        transition: IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        animateEntry: true,
    });
    assert.equal(next.active.lineIndex, 2);
    assert.equal(next.active.animateEntry, true);
    assert.equal(next.exiting, null);
    assert.equal(next.nextExitToken, 1);
});

test('unknown events are pure no-ops', () => {
    const state = createImmersiveLyricState(syncAction());
    assert.strictEqual(reduceImmersiveLyricState(state, { type: 'UNKNOWN' }), state);
});
