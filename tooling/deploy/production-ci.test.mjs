import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productionConfig } from './production-ci.mjs';

const template = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8');
const environment = { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' };
const oldConfig = `name = "flaretune"
main = "src/flaretune.js"
keep_vars = true
[[routes]]
pattern = "example.test"
custom_domain = true
[assets]
directory = "../dist"
binding = "ASSETS"
run_worker_first = ["/api", "/api/*", "/auth", "/auth/*", "/media", "/media/*"]
[vars]
MEDIA_PREFIX = "existing-media"
[[d1_databases]]
binding = "DB"
database_id = "existing-database"
[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "existing-bucket"
`;
const encode = config => Buffer.from(config).toString('base64');
for (const ending of ['\n', '\r\n']) {
  test('updates stale routes and preserves all other instance configuration: ' + JSON.stringify(ending), () => {
    const config = oldConfig.replace(/\n/g, ending);
    const output = productionConfig(template, encode(config), environment);
    assert.equal(output.replace(/^run_worker_first.*$/m, ''), config.replace(/^run_worker_first.*$/m, ''));
    assert.deepEqual(JSON.parse(output.match(/^run_worker_first = (.*)\r?$/m)[1]), JSON.parse(template.match(/^run_worker_first = (.*)\r?$/m)[1]));
    assert.equal(productionConfig(template, encode(output), environment), output);
  });
}
test('future repository routes propagate without replacing private bindings', () => {
  const next = template.replace('"/rest/*"]', '"/rest/*", "/future/*"]');
  assert.match(productionConfig(next, encode(oldConfig), environment), /"\/future\/\*"/);
});
for (const [name, config, source, env, encoded] of [
  ['wrong branch', oldConfig, template, { ...environment, WORKERS_CI_BRANCH: 'dev' }],
  ['outside CI', oldConfig, template, { ...environment, WORKERS_CI: '0' }],
  ['missing build secret', oldConfig, template, environment, ''],
  ['invalid encoding', oldConfig, template, environment, encode(oldConfig) + 'bad'],
  ['wrong Worker', oldConfig.replace('name = "flaretune"', 'name = "other"'), template, environment],
  ['variables not preserved', oldConfig.replace('keep_vars = true', 'keep_vars = false'), template, environment],
  ['missing public routes', oldConfig, template.replace(', "/rest", "/rest/*"', ''), environment],
  ['missing assets', oldConfig.replace('[assets]', '[other]'), template, environment],
  ['ambiguous routes', oldConfig, template.replace('[assets]', '[assets]\nrun_worker_first = []'), environment],
  ['invalid JSON', oldConfig, template.replace('run_worker_first = [', 'run_worker_first = [bad,'), environment],
]) {
  test('rejects ' + name + ' before any deployment', () => assert.throws(() => productionConfig(source, encoded ?? encode(config), env)));
}
