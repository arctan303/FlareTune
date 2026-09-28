import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import english from '../../client/src/i18n/en.js';

const han = /[\u3400-\u9fff]/u;
const text = (value) => value.replace(/\s+/gu, ' ').trim();
const write = process.argv.includes('--write');

function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(jsx|js)$/u.test(path) && !/\.test\./u.test(path) ? [path] : [];
  });
}

const missing = new Map();
let translated = 0;
for (const file of files('client/src')) {
  if (file.endsWith(`${sep}InstanceGate.jsx`) || file.endsWith(`${sep}AccountSettings.jsx`)) continue;
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const edits = [];
  function add(value, start, end, replacement) {
    if (!han.test(value)) return;
    if (!Object.hasOwn(english, value)) {
      if (!missing.has(value)) missing.set(value, []);
      missing.get(value).push(`${file}:${source.slice(0, start).split('\n').length}`);
      return;
    }
    edits.push({ start, end, replacement });
  }
  traverse(ast, {
    JSXText(path) {
      const value = text(path.node.value);
      if (!value) return;
      const raw = source.slice(path.node.start, path.node.end);
      const inline = !raw.includes('\n');
      const leading = inline && /^\s/u.test(raw) ? "{' '}" : '';
      const trailing = inline && /\s$/u.test(raw) ? "{' '}" : '';
      add(value, path.node.start, path.node.end,
        `${leading}{t(${JSON.stringify(value)})}${trailing}`);
    },
    JSXAttribute(path) {
      const value = path.node.value;
      if (value?.type !== 'StringLiteral') return;
      add(value.value, value.start, value.end, `{t(${JSON.stringify(value.value)})}`);
    },
  });
  if (!edits.length) continue;
  let changed = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    changed = changed.slice(0, edit.start) + edit.replacement + changed.slice(edit.end);
  }
  if (!/from ['"](?:\.\.?\/)+i18n\/index\.js['"]/u.test(changed)) {
    let path = relative(dirname(file), 'client/src/i18n/index.js').replaceAll(sep, '/');
    if (!path.startsWith('.')) path = `./${path}`;
    changed = `import { t } from '${path}';\n${changed}`;
  }
  if (write) writeFileSync(file, changed);
  translated += edits.length;
}

process.stdout.write(`Translatable static occurrences: ${translated}; missing distinct strings: ${missing.size}\n`);
if (!write) for (const [value, locations] of missing) {
  process.stdout.write(`${JSON.stringify(value)}\t${locations[0]}\n`);
}
