import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..').toLowerCase();
const pids = process.argv.slice(2).flatMap((value) => /^\d+$/.test(value) ? [Number(value)] : []);

if (pids.length === 0) {
  console.log('No explicit PIDs supplied; nothing stopped.');
  process.exit(0);
}

for (const pid of [...new Set(pids)]) {
  const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`;
  const commandLine = execFileSync('powershell.exe', ['-NoProfile', '-Command', query], { encoding: 'utf8' }).trim();
  if (!commandLine.toLowerCase().includes(repoRoot)) {
    throw new Error(`Refusing to stop PID ${pid}: command line is not owned by this repository.`);
  }
  execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { stdio: 'inherit' });
}
