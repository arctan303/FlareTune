import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('package metadata identifies FlareTune and deploys with the public root template', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'flaretune');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${pkg.version.replaceAll('.', '\\.')} `, 'm'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.deploy, 'wrangler deploy --config wrangler.toml');
  assert.equal(pkg.scripts['deploy:worker'], pkg.scripts.deploy);
  assert.equal(Object.values(pkg.scripts).some((command) => /d1[\s\S]*--remote/.test(command)), false);
  assert.deepEqual(Object.keys(pkg.cloudflare.bindings).sort(), ['DB', 'MEDIA_BUCKET', 'SETUP_SECRET']);
});

test('standard deployment template declares fresh resource defaults and only SETUP_SECRET', () => {
  const wrangler = read('wrangler.toml');
  assert.match(wrangler, /^name = "flaretune"$/m);
  assert.match(wrangler, /^main = "server\/src\/flaretune\.js"$/m);
  assert.match(wrangler, /^binding = "DB"$/m);
  assert.match(wrangler, /^binding = "MEDIA_BUCKET"$/m);
  assert.match(wrangler, /^binding = "ASSETS"$/m);
  assert.match(wrangler, /^database_name = "flaretune-db"$/m);
  assert.match(wrangler, /^database_id = ""$/m);
  assert.match(wrangler, /^bucket_name = "flaretune-media"$/m);
  assert.match(wrangler, /^migrations_dir = "server\/db\/migrations-flaretune"$/m);
  assert.match(wrangler, /run_worker_first = \[[^\n]*"\/media\/\*"/);
  assert.doesNotMatch(wrangler, /database_id = "[0-9a-f-]{36}"|\[\[routes\]\]|OAUTH_|CLIENT_ID|CLIENT_SECRET|ADMIN_API_KEY|SETUP_SECRET\s*=/);

  const secretTemplate = read('.dev.vars.example');
  const declarations = secretTemplate.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(declarations, ['SETUP_SECRET=']);
});

test('local, preview, and advanced migration profiles cannot silently reuse a production resource', () => {
  const local = read('server/wrangler.local.toml');
  const preview = read('server/preview/wrangler.toml');
  const migration = read('server/wrangler.migration.example.toml');

  assert.match(local, /^name = "flaretune-local"$/m);
  assert.match(local, /^main = "src\/flaretune\.js"$/m);
  assert.match(local, /^database_name = "flaretune-local"$/m);
  assert.match(local, /^bucket_name = "flaretune-local-media"$/m);
  assert.match(local, /^migrations_dir = "db\/migrations-flaretune"$/m);
  assert.doesNotMatch(local, /^OAUTH_ISSUER\s*=|^CLIENT_ID\s*=|^REDIRECT_URI\s*=/m);

  assert.match(preview, /^name = "flaretune-preview"$/m);
  assert.match(preview, /^main = "\.\.\/src\/flaretune\.js"$/m);
  assert.match(preview, /^migrations_dir = "\.\.\/db\/migrations-flaretune"$/m);
  assert.match(preview, /^remote = false$/m);
  assert.doesNotMatch(preview, /OAUTH_|CLIENT_SECRET|preview\.vars\.fixture/);
  assert.match(migration, /REQUIRED_NEW_FLARETUNE_WORKER_NAME/);
  assert.match(migration, /REQUIRED_NEW_FLARETUNE_D1_ID/);
  assert.match(migration, /REQUIRED_EXISTING_R2_BUCKET_NAME/);
});

test('local web development sends same-origin media requests to the local Worker', () => {
  const development = read('.env.development');
  const production = read('.env.production');
  const vite = read('client/vite.config.js');
  const contracts = read('server/src/utils/adminMusicContracts.js');

  assert.doesNotMatch(development, /VITE_R2_BASE_URL/);
  assert.doesNotMatch(production, /VITE_R2_BASE_URL/);
  assert.match(vite, /workerProxyTarget = process\.env\.FLARETUNE_DEV_WORKER_ORIGIN \|\| 'http:\/\/127\.0\.0\.1:8789'/);
  assert.match(vite, /'\/media':\s*\{[\s\S]*?target:\s*workerProxyTarget/);
  assert.match(contracts, /DEFAULT_MEDIA_PREFIX = 'media'/);
  assert.doesNotMatch(contracts, new RegExp(['dist', 'music'].join('_')));
});

test('package excludes legacy management commands and includes Web song metadata parsing', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(Object.keys(pkg.scripts).some((name) => name.startsWith('music:')), false);
  assert.equal(Object.hasOwn(pkg.dependencies, 'music-metadata'), true);
  assert.match(read('server/src/flaretune.js'), /instance\/httpRouter\.js/);
});
