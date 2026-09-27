/**
 * Stable immersive lyric effect contracts. The timing values below are
 * decorative motion budgets only; lyric progress always comes from the shared
 * canonical word timeline.
 */

export const LYRIC_EFFECT_GROUPS = Object.freeze({
  SPACE: 'space',
  FOCUS: 'focus',
  DIRECTION: 'direction',
  LIGHT: 'light',
});

export const LYRIC_WORD_EVENTS = Object.freeze({
  NONE: 'none',
  FOCUS: 'focus',
  DEW: 'dew',
  WIND: 'wind',
  RAIN: 'rain',
  FIREFLY: 'firefly',
});

export const LYRIC_TRANSLATION_PROGRESS = Object.freeze({
  NONE: 'none',
  LINE: 'line',
});

export const EFFECT_SCHEMES = Object.freeze({
  WARP: 'scheme-warp',
  THUNDER: 'scheme-thunder',
  TORNADO: 'scheme-tornado',
  MATRIX: 'scheme-matrix',
  SONIC: 'scheme-sonic',
});

export const EFFECT_TO_SCHEME = Object.freeze({
  drift: 'scheme-warp',
  'blur-focus': 'scheme-matrix',
  spring: 'scheme-thunder',
  breathe: 'scheme-warp',
  wind: 'scheme-tornado',
  dew: 'scheme-matrix',
  rain: 'scheme-sonic',
  firefly: 'scheme-thunder',
});

export const getEffectScheme = (id) => EFFECT_TO_SCHEME[id] || EFFECT_SCHEMES.WARP;

const freezeEffect = (effect) => Object.freeze({
  ...effect,
  scheme: getEffectScheme(effect.id),
  motionBudget: Object.freeze({ ...effect.motionBudget }),
});

export const LYRIC_EFFECTS = Object.freeze([
  freezeEffect({
    id: 'drift',
    name: '漂浮',
    desc: '文字像尘埃一样轻轻浮动',
    group: LYRIC_EFFECT_GROUPS.SPACE,
    wordEvent: LYRIC_WORD_EVENTS.NONE,
    translationProgress: LYRIC_TRANSLATION_PROGRESS.NONE,
    motionBudget: { enterMs: 800, exitMs: 500, resident: true },
  }),
  freezeEffect({
    id: 'blur-focus',
    name: '浅景深',
    desc: '像相机对焦，从虚到实',
    group: LYRIC_EFFECT_GROUPS.FOCUS,
    wordEvent: LYRIC_WORD_EVENTS.FOCUS,
    translationProgress: LYRIC_TRANSLATION_PROGRESS.LINE,
    motionBudget: { enterMs: 800, exitMs: 500, resident: true },
  }),
  freezeEffect({
    id: 'spring',
    name: '果冻弹簧',
    desc: '活泼有弹性，Q 弹回弹',
    group: LYRIC_EFFECT_GROUPS.SPACE,
    wordEvent: LYRIC_WORD_EVENTS.NONE,
    translationProgress: LYRIC_TRANSLATION_PROGRESS.NONE,
    motionBudget: { enterMs: 800, exitMs: 500, resident: true },
  }),
  freezeEffect({
    id: 'breathe',
    name: '晨息',
    desc: '呼吸般的张弛节奏',
    group: LYRIC_EFFECT_GROUPS.SPACE,
    wordEvent: LYRIC_WORD_EVENTS.NONE,
    translationProgress: LYRIC_TRANSLATION_PROGRESS.NONE,
    motionBudget: { enterMs: 800, exitMs: 500, resident: true },
  }),
  freezeEffect({
    id: 'wind',
    name: '风中摇曳',
    desc: '逐字随风飘入，草尖般摇摆',
    group: LYRIC_EFFECT_GROUPS.DIRECTION,
    wordEvent: LYRIC_WORD_EVENTS.WIND,
    translationProgress: LYRIC_TRANSLATION_PROGRESS.NONE,
    motionBudget: { enterMs: 750, exitMs: 450, resident: true },
  }),
  freezeEffect({
    id: 'dew',
    name: '露珠凝结',
    desc: '逐字在原地凝结生长',
    group: LYRIC_EFFECT_GROUPS.FOCUS,
    wordEvent: LYRIC_WORD_EVENTS.DEW,
    translationProgress: LYRIC_TRANSLATION_PROGRESS.LINE,
    motionBudget: { enterMs: 750, exitMs: 450, resident: true },
  }),
  freezeEffect({
    id: 'rain',
    name: '细雨',
    desc: '逐字从上方轻轻落下',
    group: LYRIC_EFFECT_GROUPS.DIRECTION,
    wordEvent: LYRIC_WORD_EVENTS.RAIN,
    translationProgress: LYRIC_TRANSLATION_PROGRESS.NONE,
    motionBudget: { enterMs: 700, exitMs: 450, resident: true },
  }),
  freezeEffect({
    id: 'firefly',
    name: '萤火',
    desc: '逐字明灭闪烁，暖色光晕',
    group: LYRIC_EFFECT_GROUPS.LIGHT,
    wordEvent: LYRIC_WORD_EVENTS.FIREFLY,
    translationProgress: LYRIC_TRANSLATION_PROGRESS.LINE,
    motionBudget: { enterMs: 800, exitMs: 500, resident: true },
  }),
]);

const EFFECT_BY_ID = new Map(LYRIC_EFFECTS.map((effect) => [effect.id, effect]));

/**
 * Resolve a persisted effect ID, falling back to the long-standing drift ID.
 */
export const getEffectConfig = (id) => EFFECT_BY_ID.get(id) || LYRIC_EFFECTS[0];

export const hashSongKey = (songKey) => {
  const value = String(songKey ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/**
 * Resolve one effect from song identity alone. Empty/missing keys intentionally
 * map to one deterministic effect instead of consulting time or randomness.
 */
export const getRandomEffect = (songKey) => (
  LYRIC_EFFECTS[hashSongKey(songKey) % LYRIC_EFFECTS.length]
);

export const resolveLyricEffect = (preferenceId, songKey, seedIndex) => {
  if (preferenceId !== 'random') {
    return getEffectConfig(preferenceId);
  }
  if (!Number.isFinite(seedIndex)) {
    return getRandomEffect(songKey);
  }
  const safeIndex = Math.trunc(seedIndex);
  const hash = hashSongKey(songKey);
  const base = hash % LYRIC_EFFECTS.length;
  const step = [1, 3, 5, 7][(hash >> 3) & 3] || 1;
  const effectIndex = ((base + safeIndex * step) % LYRIC_EFFECTS.length + LYRIC_EFFECTS.length) % LYRIC_EFFECTS.length;
  return LYRIC_EFFECTS[effectIndex];
};
