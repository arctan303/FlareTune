import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const files = [
  'README.md', 'README.en.md', 'CONTRIBUTING.md', 'CONTRIBUTING.en.md',
  ...['README', 'using-flaretune', 'deployment', 'administration', 'local-development', 'google-login']
    .flatMap((name) => [`guide/${name}.md`, `guide/${name}.en.md`]),
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
