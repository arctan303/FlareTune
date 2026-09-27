import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasStandardPlayerBlur,
} from './verify-dist-css.mjs';

test('production CSS verifier scopes standard blur to the requested player selector', () => {
  const noStandardBlur = [
    '.other-element{backdrop-filter:blur(10px)}',
    '.player-console{-webkit-backdrop-filter:var(--player-glass-blur)}',
  ].join('');

  assert.equal(hasStandardPlayerBlur(noStandardBlur, '.other-element'), false);
  assert.equal(hasStandardPlayerBlur(noStandardBlur, '.player-console'), false);

  const withStandardBlur = [
    '.player-console{-webkit-backdrop-filter:var(--player-glass-blur);backdrop-filter:var(--player-glass-blur)}',
  ].join('');

  assert.equal(hasStandardPlayerBlur(withStandardBlur, '.player-console'), true);
});
