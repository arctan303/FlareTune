#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Pass the path to an existing local .dev.vars file');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const targetPath = resolve(root, 'server/dev/.dev.vars');
const source = await readFile(sourcePath, 'utf8');
const target = await readFile(targetPath, 'utf8');

function assignedLine(contents, name) {
  const lines = contents.split(/\r?\n/);
  const matches = lines.filter((line) => new RegExp(`^\\s*${name}\\s*=`).test(line));
  if (matches.length !== 1 || !new RegExp(`^\\s*${name}\\s*=\\s*".+"\\s*$`).test(matches[0])) {
    throw new Error(`${name} must have exactly one non-empty double-quoted assignment`);
  }
  return matches[0];
}

assignedLine(target, 'SETUP_SECRET');
const aiSecret = assignedLine(source, 'DEEPSEEK_API_KEY');
const preserved = target.split(/\r?\n/)
  .filter((line) => line.trim() && !/^\s*DEEPSEEK_API_KEY\s*=/.test(line));
await writeFile(targetPath, `${preserved.join('\n')}\n${aiSecret}\n`, { mode: 0o600 });
console.log('Updated ignored development secret file: DEEPSEEK_API_KEY');
