import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Instance bindings remain in Cloudflare Builds; application routes follow Git.
export function productionConfig(template, encoded, environment) {
  if (environment.WORKERS_CI !== '1' || environment.WORKERS_CI_BRANCH !== 'main' || !encoded) {
    throw new Error('Refusing deployment outside the Cloudflare main branch build.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 100 || bytes.toString('base64') !== encoded) throw new Error('Invalid production configuration.');
  const config = bytes.toString('utf8');
  const section = /^\[assets\][ \t]*\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/gm;
  const line = /^run_worker_first[ \t]*=[ \t]*(\[[^\r\n]*\])[ \t]*\r?$/gm;
  const source = [...template.matchAll(section)];
  const target = [...config.matchAll(section)];
  if (source.length !== 1 || target.length !== 1 || !/^name = "flaretune"\r?$/m.test(config) || !/^keep_vars = true\r?$/m.test(config)) {
    throw new Error('Unexpected production configuration.');
  }
  const publicLines = [...source[0][0].matchAll(line)];
  const privateLines = [...target[0][0].matchAll(line)];
  if (publicLines.length !== 1 || privateLines.length !== 1) throw new Error('Unexpected routing configuration.');
  const routes = JSON.parse(publicLines[0][1]);
  if (!Array.isArray(routes) || routes.some(route => typeof route !== 'string' || !route.startsWith('/')) ||
      !['/api', '/api/*', '/auth', '/auth/*', '/media', '/media/*', '/rest', '/rest/*'].every(route => routes.includes(route))) {
    throw new Error('Required backend routes missing.');
  }
  const oldSection = target[0][0];
  const newSection = oldSection.replace(line, 'run_worker_first = ' + JSON.stringify(routes) + (oldSection.includes('\r\n') ? '\r' : ''));
  return config.slice(0, target[0].index) + newSection + config.slice(target[0].index + oldSection.length);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const config = productionConfig(readFileSync(resolve(root, 'wrangler.toml'), 'utf8'), process.env.FLARETUNE_PRODUCTION_CONFIG_B64, process.env);
  const path = resolve(root, 'server/wrangler.production-ci.toml');
  writeFileSync(path, config, { mode: 0o600 });
  const args = [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', path];
  if (process.argv.includes('--dry-run')) args.push('--dry-run');
  console.log('Production backend routes synchronized from repository; instance bindings preserved.');
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
