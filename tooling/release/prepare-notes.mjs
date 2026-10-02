import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function section(text, tag) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headings = lines.flatMap((line, index) => line.startsWith('## ') ? [{ line, index }] : []);
  const matching = headings.filter(({ line }) => line.startsWith(`## ${tag} — `));
  if (matching.length !== 1 || headings[0] !== matching[0]) {
    throw new Error(`The first changelog entry must be the unique ${tag} release`);
  }
  if (!new RegExp(`^## ${tag.replaceAll('.', '\\.')} — \\d{4}-\\d{2}-\\d{2}$`).test(matching[0].line)) {
    throw new Error('The release heading must include an ISO date');
  }
  const start = matching[0].index;
  const end = headings.find(({ index }) => index > start)?.index ?? lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) throw new Error(`Empty changelog entry for ${tag}`);
  return { heading: matching[0].line, body };
}

export function createReleaseNotes({ tag, packageJson, lockfile, chinese, english }) {
  const stableTag = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!stableTag || stableTag[0] !== tag) {
    throw new Error('Release tags must use the stable X.Y.Z format without a v prefix');
  }
  if ([packageJson.version, lockfile.version, lockfile.packages?.['']?.version].some((value) => value !== tag)) {
    throw new Error('Tag, package version, and both lockfile versions must match');
  }
  const zh = section(chinese, tag);
  const en = section(english, tag);
  if (zh.heading !== en.heading) throw new Error('Chinese and English release dates must match');
  return `## 简体中文\n\n${zh.body}\n\n---\n\n## English\n\n${en.body}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--tag' || args[2] !== '--output') {
    throw new Error('Usage: node tooling/release/prepare-notes.mjs --tag X.Y.Z --output FILE');
  }
  const [pkg, lock, chinese, english] = await Promise.all([
    readFile('package.json', 'utf8'), readFile('package-lock.json', 'utf8'),
    readFile('CHANGELOG.md', 'utf8'), readFile('CHANGELOG.en.md', 'utf8'),
  ]);
  const notes = createReleaseNotes({ tag: args[1], packageJson: JSON.parse(pkg), lockfile: JSON.parse(lock), chinese, english });
  await writeFile(args[3], notes, 'utf8');
  console.log(`Validated bilingual release notes for ${args[1]}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
