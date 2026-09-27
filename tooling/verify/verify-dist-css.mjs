import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const distAssetsDir = fileURLToPath(new URL('../../dist/assets', import.meta.url));

const PLAYER_SELECTORS = Object.freeze([
  '.player-console',
]);

function normalizeSelector(selector) {
  return selector
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getRuleBodies(cssContent, targetSelector) {
  const normalizedTarget = normalizeSelector(targetSelector);
  const bodies = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;

  while ((match = rulePattern.exec(cssContent)) !== null) {
    const selectors = match[1]
      .split(',')
      .map(normalizeSelector);
    if (selectors.includes(normalizedTarget)) {
      bodies.push(match[2]);
    }
  }

  return bodies;
}

function bodyHasDeclaration(body, property, valuePattern) {
  const declarationPattern = new RegExp(
    `(?:^|;)\\s*${property}:\\s*${valuePattern}(?:;|$)`,
  );
  return declarationPattern.test(body);
}

export function hasStandardPlayerBlur(cssContent, selector) {
  return getRuleBodies(cssContent, selector).some((body) => (
    bodyHasDeclaration(
      body,
      'backdrop-filter',
      'var\\(--player-glass-blur\\)',
    )
  ));
}

function runSelfCheck() {
  const webkitOnly = '.player-console{-webkit-backdrop-filter:var(--player-glass-blur)}';
  assert.equal(
    hasStandardPlayerBlur(webkitOnly, '.player-console'),
    false,
    'WebKit-only blur must not satisfy the standard player blur contract.',
  );

  const unrelatedStandard = '.unrelated{backdrop-filter:var(--player-glass-blur)}';
  assert.equal(
    hasStandardPlayerBlur(unrelatedStandard, '.player-console'),
    false,
    'A standard declaration on an unrelated selector must not satisfy the player contract.',
  );
}

function verifyDistCss() {
  runSelfCheck();

  let files;
  try {
    files = readdirSync(distAssetsDir);
  } catch {
    console.error('dist/assets directory not found. Please run npm run build first.');
    process.exit(1);
  }

  const cssFiles = files.filter((file) => file.endsWith('.css') && file.startsWith('main-'));
  if (cssFiles.length === 0) {
    console.error('No main CSS file found in dist/assets.');
    process.exit(1);
  }

  for (const cssFile of cssFiles) {
    const content = readFileSync(join(distAssetsDir, cssFile), 'utf8');

    for (const selector of PLAYER_SELECTORS) {
      assert.ok(
        hasStandardPlayerBlur(content, selector),
        `Standard backdrop-filter missing for ${selector} in ${cssFile}`,
      );
    }
  }

  console.log(`✓ Verified ${cssFiles.length} production CSS file(s) with rule-scoped contracts.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyDistCss();
}
