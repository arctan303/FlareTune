import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule;
const han = /[\u3400-\u9fff]/u;
const text = (value) => value.replace(/\s+/gu, ' ').trim();

function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(jsx|js)$/u.test(path) && !/\.test\./u.test(path) ? [path] : [];
  });
}

const entries = [];
for (const file of files('client/src')) {
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  traverse(ast, {
    JSXText(path) {
      const value = text(path.node.value);
      if (han.test(value)) entries.push({ file, line: path.node.loc.start.line, kind: 'text', value });
    },
    JSXAttribute(path) {
      const value = path.node.value;
      if (value?.type === 'StringLiteral' && han.test(value.value)) {
        entries.push({ file, line: value.loc.start.line, kind: `attribute:${path.node.name.name}`, value: value.value });
      }
    },
  });
}

const unique = [...new Set(entries.map(({ value }) => value))].sort((a, b) => a.localeCompare(b, 'zh'));
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ entries, unique }, null, 2));
else {
  process.stdout.write(`Entries: ${entries.length}; unique: ${unique.length}\n`);
  for (const value of unique) process.stdout.write(`${value}\n`);
}
