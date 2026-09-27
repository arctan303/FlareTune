import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VISUAL_MOTION_PHASE,
  VISUAL_MOTION_PROFILE,
  getDrawerVisibilityUpdate,
  getVisualMotionProfile,
  getPlaylistVisibilityUpdate,
  resolveVisualMotionProfile,
} from './motionPerformance.js';

test('REDMI K Pad landscape coarse-pointer uses the full visual pipeline', () => {
  const width = 1280;
  const height = 800;
  assert.equal(
    resolveVisualMotionProfile({
      coarsePointer: true,
      hoverNone: true,
      viewportWidth: width,
      viewportHeight: height,
    }),
    VISUAL_MOTION_PROFILE.FULL,
  );
});

test('REDMI K Pad portrait coarse-pointer uses the full visual pipeline', () => {
  const width = 800;
  const height = 1280;
  assert.equal(
    resolveVisualMotionProfile({
      coarsePointer: true,
      hoverNone: true,
      viewportWidth: width,
      viewportHeight: height,
    }),
    VISUAL_MOTION_PROFILE.FULL,
  );
});

test('600px-and-up touch viewports share the full visual pipeline', () => {
  // Layout can remain compact at this width, but visual quality is full.
  assert.equal(
    resolveVisualMotionProfile({
      coarsePointer: true,
      hoverNone: true,
      viewportWidth: 768,
      viewportHeight: 1024,
    }),
    VISUAL_MOTION_PROFILE.FULL,
  );

  // Desktop-width touch viewports use the same visual profile as fine-pointer desktops.
  assert.equal(
    resolveVisualMotionProfile({
      coarsePointer: true,
      hoverNone: true,
      viewportWidth: 1024,
      viewportHeight: 768,
    }),
    VISUAL_MOTION_PROFILE.FULL,
  );

  // Below 600px (599px mobile touch upper bound) -> COMPACT_TOUCH
  assert.equal(
    resolveVisualMotionProfile({
      coarsePointer: true,
      hoverNone: true,
      viewportWidth: 599,
      viewportHeight: 1000,
    }),
    VISUAL_MOTION_PROFILE.COMPACT_TOUCH,
  );
});

test('same device forced into phone viewport width uses compact-touch', () => {
  const width = 390;
  const height = 844;
  assert.equal(
    resolveVisualMotionProfile({
      coarsePointer: true,
      hoverNone: true,
      viewportWidth: width,
      viewportHeight: height,
    }),
    VISUAL_MOTION_PROFILE.COMPACT_TOUCH,
  );
});

test('fine-pointer desktops keep full motion even at high resolution', () => {
  assert.equal(
    resolveVisualMotionProfile({
      coarsePointer: false,
      hoverNone: false,
      viewportWidth: 1440,
      viewportHeight: 900,
      physicalPixels: 8_294_400,
    }),
    VISUAL_MOTION_PROFILE.FULL,
  );
});

test('touch-capable desktops with fine pointer keep full theme transitions', () => {
  const matches = new Map([
    ['(prefers-reduced-motion: reduce)', false],
    ['(pointer: coarse)', false],
    ['(pointer: fine)', true],
    ['(hover: none)', false],
    ['(hover: hover)', true],
  ]);
  const desktopWindow = {
    innerWidth: 1440,
    innerHeight: 900,
    navigator: { maxTouchPoints: 10 },
    visualViewport: null,
    matchMedia: (query) => ({ matches: matches.get(query) ?? false }),
  };

  assert.equal(getVisualMotionProfile(desktopWindow), VISUAL_MOTION_PROFILE.FULL);
});

test('touch viewport remains compact when desktop input is narrowed below tablet size', () => {
  const matches = new Map([
    ['(prefers-reduced-motion: reduce)', false],
    ['(pointer: coarse)', false],
    ['(pointer: fine)', true],
    ['(hover: none)', false],
    ['(hover: hover)', true],
  ]);
  const narrowTouchWindow = {
    innerWidth: 390,
    innerHeight: 844,
    navigator: { maxTouchPoints: 10 },
    visualViewport: null,
    matchMedia: (query) => ({ matches: matches.get(query) ?? false }),
  };

  assert.equal(getVisualMotionProfile(narrowTouchWindow), VISUAL_MOTION_PROFILE.COMPACT_TOUCH);
});

test('reduced motion always wins over the device performance tier', () => {
  assert.equal(
    resolveVisualMotionProfile({
      prefersReducedMotion: true,
      coarsePointer: true,
      hoverNone: true,
      viewportWidth: 1280,
      viewportHeight: 800,
      physicalPixels: 8_294_400,
    }),
    VISUAL_MOTION_PROFILE.REDUCED,
  );
});

test('playlist visibility and drawer phase change atomically in both directions', () => {
  assert.deepEqual(
    getPlaylistVisibilityUpdate(false, true),
    {
      isPlaylistOpen: true,
      visualMotionPhase: VISUAL_MOTION_PHASE.DRAWER,
    },
  );
  assert.deepEqual(
    getPlaylistVisibilityUpdate(true, false),
    {
      isPlaylistOpen: false,
      visualMotionPhase: VISUAL_MOTION_PHASE.DRAWER,
    },
  );
});

test('every drawer can change visibility and motion phase atomically', () => {
  assert.deepEqual(
    getDrawerVisibilityUpdate(false, true, 'isAiReviewOpen'),
    {
      isAiReviewOpen: true,
      visualMotionPhase: VISUAL_MOTION_PHASE.DRAWER,
    },
  );
  assert.deepEqual(
    getDrawerVisibilityUpdate(true, false, 'isToolsDrawerOpen'),
    {
      isToolsDrawerOpen: false,
      visualMotionPhase: VISUAL_MOTION_PHASE.DRAWER,
    },
  );
});

test('repeating the current playlist state does not start a phantom transition', () => {
  assert.equal(getPlaylistVisibilityUpdate(false, false), null);
  assert.equal(getPlaylistVisibilityUpdate(true, (current) => current), null);
});
