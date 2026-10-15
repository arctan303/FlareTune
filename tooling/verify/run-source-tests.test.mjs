import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { sourceTestFiles } from './run-source-tests.mjs';

test('source test discovery includes every source area and excludes old/generated snapshots', t => {
  const directory = mkdtempSync(join(tmpdir(), 'flaretune-source-tests-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('flaretune-source-tests-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const expected = [];
  for (const source of ['client', 'server', 'shared', 'demo', 'tooling', 'tests']) {
    const file = join(directory, source, 'nested', 'current.test.mjs');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
    expected.push(file);
  }
  for (const relative of ['output/old.test.js', 'dist/old.test.mjs',
    'client/node_modules/vendor.test.js', 'server/.wrangler/old.test.js',
    'tooling/output/snapshot.test.mjs', 'tests/nested/helper.js']) {
    const file = join(directory, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  assert.deepEqual(sourceTestFiles(directory), expected.sort());
});
