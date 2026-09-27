import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const vite = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
const port = Number(process.env.FLARETUNE_DEV_CLIENT_PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('FLARETUNE_DEV_CLIENT_PORT 必须是有效端口号。');
}
const worker = process.env.FLARETUNE_DEV_WORKER_ORIGIN || 'https://flaretune-dev.arctan.workers.dev';
if (!/^https:\/\//i.test(worker)) throw new Error('开发 Worker 地址必须使用 HTTPS。');
const origin = `http://127.0.0.1:${port}`;
console.info(`本地前端：${origin} → 开发 Worker：${worker}`);

const child = spawn(process.execPath, [vite, '--config', 'client/vite.config.js', '--port', String(port)], {
  cwd: root,
  env: { ...process.env, FLARETUNE_DEV_WORKER_ORIGIN: worker,
    FLARETUNE_LOCAL_WEB_ORIGIN: origin },
  stdio: 'inherit',
});
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
