// Disposable local browser harness. The generated setup secret exists only for
// this process and its ephemeral Miniflare binding; never use it for deployment.
import { randomBytes } from 'node:crypto';
import { startPreview } from './preview-worker.mjs';

const secret = randomBytes(32).toString('base64url');
const preview = await startPreview({ ephemeral: true,
  seedMigrationPending: process.argv.includes('--pending-migration'),
  workerTestBindings: { SETUP_SECRET: secret } });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await preview.stop();
  process.exit(0);
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.stdin.resume();
process.stdin.once('data', () => { void stop(); });
process.stdout.write(`Local browser preview: ${preview.origin}\nDisposable setup secret: ${secret}\nPress Enter to discard its local database.\n`);
