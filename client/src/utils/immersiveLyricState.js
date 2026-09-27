export const IMMERSIVE_LYRIC_ACTIONS = Object.freeze({
    SYNC: 'SYNC',
    ANIMATION_END: 'ANIMATION_END',
});

export const IMMERSIVE_LYRIC_TRANSITIONS = Object.freeze({
    ADVANCE: 'advance',
    SEEK: 'seek',
    SYNC: 'sync',
    CONTENT: 'content',
});

/**
 * SYNC accepts the resolved song/effect/presentation plus the current lifecycle
 * gates (`loading`, `visible`, `reducedMotion`) and an explicit transition
 * reason. Only `transition: 'advance'` is eligible for decorative entry/exit.
 * ANIMATION_END is deliberately fail-closed and requires the exiting layer's
 * token, identity and CSS animationName.
 */

const EMPTY_LINE_INDEX = -1;
const FIRST_EXIT_TOKEN = 1;

const emptyState = () => ({
    active: null,
    exiting: null,
    nextExitToken: FIRST_EXIT_TOKEN,
});

const normalizeSongKey = (songKey) => String(songKey ?? '');

const normalizePresentationKind = (presentation) => (
    typeof presentation?.kind === 'string' && presentation.kind
        ? presentation.kind
        : 'none'
);

const normalizeLineIndex = (lineIndex, presentation) => {
    // The precise presentation owns row selection; a low-frequency external
    // index may only fill the value when presentation has no index at all.
    if (Number.isFinite(presentation?.index)) return Math.trunc(presentation.index);
    return Number.isFinite(lineIndex) ? Math.trunc(lineIndex) : EMPTY_LINE_INDEX;
};

export function getImmersiveLyricIdentity({
    songKey,
    presentation,
    lineIndex,
} = {}) {
    return JSON.stringify([
        normalizeSongKey(songKey),
        normalizePresentationKind(presentation),
        normalizeLineIndex(lineIndex, presentation),
    ]);
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const resolveLine = (action, presentation) => {
    if (hasOwn(presentation, 'line')) return presentation.line;
    if (hasOwn(action, 'line')) return action.line;
    return null;
};

const resolveText = (action, line) => {
    if (hasOwn(action, 'text')) return action.text ?? '';
    if (typeof line === 'string') return line;
    return line?.text ?? '';
};

const resolveTranslation = (action, line) => {
    if (hasOwn(action, 'translation')) return action.translation ?? '';
    return typeof line === 'object' && line !== null
        ? (line.translation ?? '')
        : '';
};

const createLayer = (action, animateEntry = false) => {
    const presentation = action.presentation || {};
    const songKey = normalizeSongKey(action.songKey);
    const kind = normalizePresentationKind(presentation);
    const lineIndex = normalizeLineIndex(action.lineIndex, presentation);
    const line = resolveLine(action, presentation);
    return {
        identity: getImmersiveLyricIdentity({ songKey, presentation, lineIndex }),
        songKey,
        kind,
        lineIndex,
        effectId: typeof action.effectId === 'string' && action.effectId
            ? action.effectId
            : 'drift',
        line,
        text: resolveText(action, line),
        translation: resolveTranslation(action, line),
        animateEntry,
    };
};

const sameLayerContent = (left, right) => (
    left?.identity === right?.identity
    && left?.effectId === right?.effectId
    && left?.line === right?.line
    && left?.text === right?.text
    && left?.translation === right?.translation
    && left?.animateEntry === right?.animateEntry
);

const isAdjacentLineAdvance = (previous, next, transition) => (
    transition === IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE
    && previous?.songKey === next?.songKey
    && previous?.kind === 'line'
    && next?.kind === 'line'
    && next.lineIndex === previous.lineIndex + 1
);

const exitAnimationName = (action, previous) => {
    if (typeof action.exitAnimationName === 'function') {
        const name = action.exitAnimationName(previous);
        return typeof name === 'string' && name.trim() ? name.trim() : null;
    }
    return typeof action.exitAnimationName === 'string' && action.exitAnimationName.trim()
        ? action.exitAnimationName.trim()
        : null;
};

const syncState = (state, action) => {
    const presentation = action.presentation || {};
    const kind = normalizePresentationKind(presentation);
    const loading = action.loading === true;
    const visible = action.visible !== false;
    const reducedMotion = action.reducedMotion === true;

    if (loading || kind === 'none') {
        if (state.active === null && state.exiting === null) return state;
        return { ...state, active: null, exiting: null };
    }

    const nextBase = createLayer(action, false);
    if (!visible || reducedMotion) {
        const active = sameLayerContent(state.active, nextBase) ? state.active : nextBase;
        if (active === state.active && state.exiting === null) return state;
        return { ...state, active, exiting: null };
    }

    if (state.active?.identity === nextBase.identity) {
        const effectChanged = state.active.effectId !== nextBase.effectId;
        const seeked = action.transition === IMMERSIVE_LYRIC_TRANSITIONS.SEEK;
        const exiting = effectChanged || seeked ? null : state.exiting;
        const active = sameLayerContent(state.active, nextBase) ? state.active : nextBase;
        if (active === state.active && exiting === state.exiting) return state;
        return { ...state, active, exiting };
    }

    const adjacentAdvance = isAdjacentLineAdvance(
        state.active,
        nextBase,
        action.transition,
    );
    const canAnimateInitialEntry = state.active === null
        && action.transition === IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE;
    const active = {
        ...nextBase,
        animateEntry: action.animateEntry === true
            && (adjacentAdvance || canAnimateInitialEntry),
    };

    if (!adjacentAdvance) {
        return { ...state, active, exiting: null };
    }

    const animationName = exitAnimationName(action, state.active);
    if (!animationName) {
        return { ...state, active, exiting: null };
    }

    const token = state.nextExitToken;
    return {
        active,
        exiting: {
            ...state.active,
            animateEntry: false,
            token,
            animationName,
        },
        nextExitToken: token + 1,
    };
};

const finishExitAnimation = (state, action) => {
    const exiting = state.exiting;
    if (!exiting
        || action.token !== exiting.token
        || action.identity !== exiting.identity
        || action.animationName !== exiting.animationName) return state;
    return { ...state, exiting: null };
};

export function reduceImmersiveLyricState(currentState, action = {}) {
    const state = currentState
        && Number.isInteger(currentState.nextExitToken)
        ? currentState
        : emptyState();
    switch (action.type) {
        case IMMERSIVE_LYRIC_ACTIONS.SYNC:
            return syncState(state, action);
        case IMMERSIVE_LYRIC_ACTIONS.ANIMATION_END:
            return finishExitAnimation(state, action);
        default:
            return state;
    }
}

export function createImmersiveLyricState(initialSync) {
    const state = emptyState();
    if (!initialSync) return state;
    return reduceImmersiveLyricState(state, {
        ...initialSync,
        type: IMMERSIVE_LYRIC_ACTIONS.SYNC,
    });
}
