import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const files = [
  'README.md', 'README.en.md', 'CONTRIBUTING.md', 'CONTRIBUTING.en.md',
  ...readdirSync('guide').filter(name => name.endsWith('.md')).map(name => `guide/${name}`),
  'tooling/ingest-agent/README.md', 'tooling/ingest-agent/README.en.md',
];
const missing = [];
for (const file of files) {
  const markdown = readFileSync(file, 'utf8');
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/gu)) {
    const target = match[1].split('#')[0].split('?')[0];
    if (!target || /^(?:[a-z]+:|\/\/)/iu.test(target)) continue;
    if (!existsSync(resolve(dirname(file), decodeURIComponent(target)))) missing.push(`${file}: ${match[1]}`);
  }
}
for (const item of missing) process.stderr.write(`Missing public doc link: ${item}\n`);
process.stdout.write(`${files.length} documents checked; ${missing.length} broken relative links\n`);
if (missing.length) process.exitCode = 1;
