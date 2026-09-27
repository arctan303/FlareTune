import { configureAgent, startConfiguredAgent } from './agent.mjs';

try {
  if (process.argv[2] === 'configure') await configureAgent();
  else if (!process.argv[2] || process.argv[2] === 'start') await startConfiguredAgent();
  else throw new Error('用法：node tooling/ingest-agent/cli.mjs [configure|start]');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
