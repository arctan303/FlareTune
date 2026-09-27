import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = resolve(root, 'wrangler.toml');
const dryRun = process.argv.includes('--dry-run');

if (process.env.WORKERS_CI !== '1' || process.env.WORKERS_CI_BRANCH !== 'dev') {
  throw new Error('Refusing deployment outside the Cloudflare dev branch build.');
}
const databaseId = process.env.FLARETUNE_DEV_D1_ID;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId || '')) {
  throw new Error('FLARETUNE_DEV_D1_ID must be the existing development D1 database UUID.');
}
// Pin the existing development D1 without publishing its UUID.
const expectedDatabaseHash = 'dc5903fa4191441af4be867084a6720983eb87b14d8824cc9cb24c2efaef6554';
if (createHash('sha256').update(databaseId.toLowerCase()).digest('hex') !== expectedDatabaseHash) {
  throw new Error('FLARETUNE_DEV_D1_ID does not identify the configured development database.');
}
const config = readFileSync(configPath, 'utf8');
const marker = 'database_id = "__FLARETUNE_DEV_D1_ID__"';
if (config.split(marker).length !== 2 ||
    !config.includes('name = "flaretune"') ||
    !config.includes('[env.dev]') ||
    !config.includes('database_name = "flaretune-db-dev"') ||
    !config.includes('bucket_name = "flaretune-files-dev"')) {
  throw new Error('Unexpected development Wrangler configuration; deployment stopped.');
}
writeFileSync(configPath, config.replace(marker, `database_id = "${databaseId}"`));
const args = ['wrangler', 'deploy', '--env', 'dev'];
if (dryRun) args.push('--dry-run');
const result = spawnSync('npx', args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
