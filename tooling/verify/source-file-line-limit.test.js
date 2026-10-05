import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.tmp',
  '.playwright-cli',
  '.wrangler',
  'coverage',
  'dist',
  'music-data',
  'node_modules',
  'output',
]);
const SOURCE_LINE_LIMIT = 1_000;
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function countSourceLines(source) {
  if (source.length === 0) return 0;
  const lines = source.split(/\r\n|\r|\n/u).length;
  return /(?:\r\n|\r|\n)$/u.test(source) ? lines - 1 : lines;
}

export async function findSourceLineLimitViolations(root, { limit = SOURCE_LINE_LIMIT } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer');
  const violations = [];

  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      const lineCount = countSourceLines(await readFile(absolutePath, 'utf8'));
      if (lineCount >= limit) {
        violations.push({
          path: relativePath,
          lineCount,
        });
      }
    }
  };

  await visit(root);
  return violations;
}

export async function assertSourceFileLineLimit(root, { limit = SOURCE_LINE_LIMIT } = {}) {
  const violations = await findSourceLineLimitViolations(root, { limit });
  assert.deepEqual(
    violations,
    [],
    `Source files must stay below ${limit} lines:\n${violations
      .map(({ path, lineCount }) => `- ${path}: ${lineCount}`)
      .join('\n')}`,
  );
}

test('first-party source files stay below 1000 lines', async () => {
  await assertSourceFileLineLimit(PROJECT_ROOT);
});

test('line-limit scanner fails a 1000-line fixture and ignores generated directories', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'arc-source-line-limit-'));
  try {
    const writeLines = async (path, count) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${Array.from({ length: count }, () => '// line').join('\n')}\n`, 'utf8');
    };
    await writeLines(join(fixtureRoot, 'small.js'), 999);
    await writeLines(join(fixtureRoot, 'too-large.tsx'), 1_000);
    for (const excluded of ['node_modules', 'dist', 'output', 'music-data', '.tmp', '.wrangler', '.playwright-cli']) {
      await writeLines(join(fixtureRoot, excluded, 'generated.js'), 1_001);
    }

    assert.deepEqual(await findSourceLineLimitViolations(fixtureRoot), [
      { path: 'too-large.tsx', lineCount: 1_000 },
    ]);
    await assert.rejects(
      assertSourceFileLineLimit(fixtureRoot),
      /too-large\.tsx: 1000/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
