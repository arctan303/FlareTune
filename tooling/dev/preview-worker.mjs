import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyWorkerHttp } from '../verify/verify-worker-http.mjs';
import { runPlaylistCountMigration } from '../../server/src/instance/playlistCountMigration.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = resolve(root, 'server/preview/wrangler.toml');
const previewStateRoot = resolve(root, 'server/.wrangler');
const forbiddenEnv = /(?:SECRET|TOKEN|API_KEY|PASSWORD|OAUTH|OPENAI|DEEPSEEK|GEMINI)/i;

export function buildChildEnv(source = process.env) {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'ComSpec'];
  const env = Object.fromEntries(allowed.flatMap((key) => source[key] ? [[key, source[key]]] : []));
  env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  env.WRANGLER_LOG_PATH = resolve(root, '.tmp/wrangler-preview.log');
  env.WRANGLER_REGISTRY_PATH = resolve(root, 'server/.wrangler/registry-preview');
  return env;
}

export async function validatePreviewConfig() {
  const config = await readFile(configPath, 'utf8');
  assert.match(config, /main\s*=\s*"\.\.\/src\/flaretune\.js"/);
  assert.match(config, /directory\s*=\s*"\.\.\/\.\.\/dist"/);
  assert.match(config, /migrations_dir\s*=\s*"\.\.\/db\/migrations-flaretune"/);
  assert.equal((config.match(/remote\s*=\s*false/g) || []).length, 2);
  assert.doesNotMatch(config, /remote\s*=\s*true|\[\[routes\]\]|custom_domain|dispatch_namespaces|\[\[services\]\]|OAUTH_|CLIENT_SECRET|ADMIN_API_KEY/);
  for (const value of config.matchAll(/https?:\/\/[^"\s,]+/g)) {
    assert.ok(['127.0.0.1', 'localhost'].includes(new URL(value[0]).hostname), `non-loopback preview URL: ${value[0]}`);
  }
  assert.ok(Object.keys(buildChildEnv()).every((key) => !forbiddenEnv.test(key)));
}

function assertPreviewStatePath(path) {
  const rel = relative(previewStateRoot, resolve(path));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === resolve(path)) {
    throw new Error('Preview state path must be a child of server/.wrangler');
  }
}

async function loadRuntime() {
  const [wrangler, miniflare, esbuild] = await Promise.all([import('wrangler'), import('miniflare'), import('esbuild')]);
  return { wrangler, miniflare, esbuild };
}

async function seed(db, bucket, splitSqlQuery, { migrationPending = false } = {}) {
  let existing;
  try { existing = await db.prepare('SELECT id FROM ft_instance WHERE id = 1').first(); }
  catch { existing = null; }
  if (!existing) {
    for (const file of ['0001_baseline.sql', '0002_expand_playlist_count.sql']) {
      const sql = await readFile(resolve(root, 'server/db/migrations-flaretune', file), 'utf8');
      const statements = splitSqlQuery(sql).map((statement) => statement.trim()).filter(Boolean);
      await db.batch(statements.map((statement) => db.prepare(statement)));
    }
    if (!migrationPending) {
      let migration;
      for (let step = 0; step < 4; step += 1) {
        migration = await runPlaylistCountMigration(db, {
          ownerToken: crypto.randomUUID().replaceAll('-', ''),
        });
        if (migration.status === 'completed') break;
      }
      if (migration.status !== 'completed') throw new Error('Preview D1 failed to complete the built-in v2 migration.');
    }
  }
  if (!migrationPending) {
    const memoryTable = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_memories'").first();
    if (!memoryTable) {
      const sql = await readFile(resolve(root, 'server/db/migrations-flaretune/0008_assistant_memory.sql'), 'utf8');
      const statements = splitSqlQuery(sql).map((statement) => statement.trim()).filter(Boolean);
      await db.batch(statements.map((statement) => db.prepare(statement)));
    }
  }
  await bucket.put('media/audio/fixture-song.mp3', new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0]), {
    httpMetadata: { contentType: 'audio/mpeg' },
  });
}

async function startRuntime({ runtime: { wrangler, miniflare, esbuild }, statePath,
  workerTestBindings = null, seedMigrationPending = false, seedEmpty = false }) {
  const [generated, bundle] = await Promise.all([
    wrangler.unstable_getMiniflareWorkerOptions(configPath),
    esbuild.build({ entryPoints: [resolve(root, 'server/src/flaretune.js')], bundle: true, write: false, format: 'esm', platform: 'browser' }),
  ]);
  const options = JSON.parse(JSON.stringify(generated.workerOptions));
  delete options.modulesRules;
  let mf;
  try {
    mf = new miniflare.Miniflare(miniflare.convertV4MiniflareOptions({
      host: '127.0.0.1', port: 8790, cachePersist: statePath, d1Persist: statePath, r2Persist: statePath,
      workers: [{ ...options, bindings: { ...options.bindings, ...workerTestBindings },
        name: 'flaretune-preview', modules: true, script: bundle.outputFiles[0].text,
        outboundService: () => { throw new Error('PREVIEW_OUTBOUND_BLOCKED'); } }, ...generated.externalWorkers],
    }));
    await mf.ready;
    const bindings = await mf.getBindings('flaretune-preview');
    if (!seedEmpty) await seed(bindings.DB, bindings.MEDIA_BUCKET, wrangler.unstable_splitSqlQuery,
      { migrationPending: seedMigrationPending });
    return mf;
  } catch (error) {
    if (mf?.dispose) {
      try { await mf.dispose(); } catch (cleanupError) { error.cleanupErrors = [...(error.cleanupErrors || []), cleanupError]; }
    }
    throw error;
  }
}

async function cleanupPreview({ mf, statePath, removeState }) {
  const results = await Promise.allSettled([
    ...(mf?.dispose ? [Promise.resolve().then(() => mf.dispose())] : []),
    ...(removeState ? [Promise.resolve().then(() => rm(statePath, { recursive: true, force: true }))] : []),
  ]);
  return results.filter((result) => result.status === 'rejected').map((result) => result.reason);
}

export async function startPreview({ ephemeral = false, runtimeLoader = loadRuntime, runtimeStarter = startRuntime,
  statePath: override, workerTestBindings = null, seedMigrationPending = false, seedEmpty = false } = {}) {
  await validatePreviewConfig();
  if (workerTestBindings && (!ephemeral || Object.keys(workerTestBindings).some((key) => key !== 'SETUP_SECRET'))) {
    throw new Error('Only an ephemeral local preview can receive a test SETUP_SECRET binding');
  }
  if (seedMigrationPending && !ephemeral) throw new Error('Pending-migration seed is only allowed in ephemeral previews');
  if (seedEmpty && (!ephemeral || seedMigrationPending)) throw new Error('Empty seed is only allowed in an ephemeral fresh preview');
  const statePath = override || (ephemeral
    ? resolve(previewStateRoot, `state-preview-smoke-${process.pid}`)
    : resolve(previewStateRoot, 'state-preview'));
  assertPreviewStatePath(statePath);
  let mf;
  try {
    await mkdir(statePath, { recursive: true });
    mf = await runtimeStarter({ runtime: await runtimeLoader(), statePath,
      workerTestBindings, seedMigrationPending, seedEmpty });
  } catch (error) {
    const cleanupErrors = await cleanupPreview({ mf, statePath, removeState: ephemeral });
    if (cleanupErrors.length) error.cleanupErrors = [...(error.cleanupErrors || []), ...cleanupErrors];
    throw error;
  }
  let stopped = false;
  return {
    origin: 'http://127.0.0.1:8790',
    async stop() {
      if (stopped) return;
      stopped = true;
      const errors = await cleanupPreview({ mf, statePath, removeState: ephemeral });
      if (errors.length) throw new AggregateError(errors, 'preview cleanup failed');
    },
  };
}

async function main() {
  if (!process.argv.includes('--isolated-child')) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated-child', ...process.argv.slice(2)], {
      cwd: root, env: buildChildEnv(), stdio: 'inherit', windowsHide: true,
    });
    process.exitCode = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (value, signal) => done(value ?? (signal ? 1 : 0)));
    });
    return;
  }
  const smoke = process.argv.includes('--smoke');
  const preview = await startPreview({ ephemeral: smoke });
  const stop = () => preview.stop().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`isolated worker preview: ${preview.origin}`);
  if (smoke) {
    try { await verifyWorkerHttp(preview.origin); console.log('isolated worker preview smoke: PASS'); }
    finally { await preview.stop(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
