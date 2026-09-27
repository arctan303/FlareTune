import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyWorkerAssets } from './verify-worker-assets.mjs';

test('asset verification rejects a stale Pages worker even when assetsignore excludes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-assets-'));
  try {
    for (const name of ['index.html', '404.html', '.assetsignore', '_headers']) await writeFile(join(dir,name), 'fixture');
    assert.equal((await verifyWorkerAssets(dir)).length, 4);
    await writeFile(join(dir, '_worker.js'), 'export default { fetch() {} }');
    await assert.rejects(verifyWorkerAssets(dir), /Private asset forbidden/);
    await rm(join(dir, '_worker.js'));
    await writeFile(join(dir, 'internal-config.json'), '{"fixture":"private"}');
    await assert.rejects(verifyWorkerAssets(dir), /Unclassified public path/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
