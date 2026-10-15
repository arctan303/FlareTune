#!/usr/bin/env node
import { configureAgent, startConfiguredAgent } from './agent.mjs';

const packaged = typeof __FLARETUNE_INGEST_VERSION__ === 'string';
const command = packaged ? 'flaretune-ingest' : 'npm run ingest';
const configure = packaged ? 'npx flaretune-ingest@latest configure' : 'npm run ingest:configure';
const usage = `Usage: ${command} [configure|start|--help|--version]`;

try {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error(usage);
  if (['--help', '-h', 'help'].includes(args[0])) console.log(`${usage}\n\nConfigure: ${configure}\nStart: ${packaged ? 'npx flaretune-ingest@latest start' : command}`);
  else if (['--version', '-v'].includes(args[0])) console.log(packaged ? __FLARETUNE_INGEST_VERSION__ : 'source');
  else if (args[0] === 'configure') await configureAgent({ startCommand: packaged ? 'npx flaretune-ingest@latest start' : command });
  else if (!args[0] || args[0] === 'start') await startConfiguredAgent();
  else throw new Error(usage);
} catch (error) {
  console.error(error.code === 'ENOENT' && process.argv[2] !== 'configure'
    ? `Device configuration is missing. Run ${configure} first.` : error.message);
  process.exitCode = 1;
}
