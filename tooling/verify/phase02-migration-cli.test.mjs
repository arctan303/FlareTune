import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const localConfig = readFileSync(path.join(repoRoot, 'server/wrangler.local.toml'), 'utf8');
const deploymentConfig = readFileSync(path.join(repoRoot, 'wrangler.toml'), 'utf8');

test('FlareTune local migration scripts target only the new D1 migration chain', () => {
  const expectedCommon = 'DB --local --config server/wrangler.local.toml --persist-to worker/.wrangler/state';
  assert.equal(pkg.scripts['db:migrations:list:local'], `wrangler d1 migrations list ${expectedCommon}`);
  assert.equal(pkg.scripts['db:migrations:apply:local'], `wrangler d1 migrations apply ${expectedCommon}`);

  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (!name.startsWith('db:')) continue;
    assert.doesNotMatch(command, /--remote|migrations-v5|server\/db\/migrations\//);
  }
  assert.deepEqual(Object.keys(pkg.scripts).filter((name) => name.startsWith('db:migrate:')), []);
});

test('local and public D1 bindings select the same FlareTune migration chain', () => {
  assert.match(localConfig, /binding\s*=\s*"DB"/);
  assert.match(localConfig, /migrations_dir\s*=\s*"db\/migrations-flaretune"/);
  assert.match(deploymentConfig, /binding\s*=\s*"DB"/);
  assert.match(deploymentConfig, /migrations_dir\s*=\s*"server\/db\/migrations-flaretune"/);
});
