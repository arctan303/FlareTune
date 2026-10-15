import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoots = ['client', 'server', 'shared', 'demo', 'tooling', 'tests'];
const generatedDirectories = new Set(['node_modules', '.git', '.wrangler', 'dist', 'dist-demo', 'output']);

export function sourceTestFiles(directory = root) {
  const files = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory() && !generatedDirectories.has(entry.name)) visit(path);
      else if (entry.isFile() && /\.test\.(?:js|mjs|cjs)$/u.test(entry.name)) files.push(path);
    }
  }
  for (const source of sourceRoots) visit(resolve(directory, source));
  return files.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = sourceTestFiles();
  if (!files.length) throw new Error('No source tests found');
  console.log(`Running ${files.length} source test files`);
  const result = spawnSync(process.execPath, ['--experimental-sqlite', '--test', '--test-concurrency=4',
    ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
