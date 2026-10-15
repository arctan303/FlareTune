import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function runNpm(args, options = {}) {
  let cli = process.env.npm_execpath;
  if (!cli || !existsSync(cli)) cli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(cli) && process.platform !== 'win32') {
    cli = realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim());
  }
  if (!existsSync(cli)) throw new Error('Run this command through npm run so the npm CLI can be located.');
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
}
