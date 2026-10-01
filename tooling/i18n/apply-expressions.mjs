import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import english from '../../client/src/i18n/en.js';

const han = /[\u3400-\u9fff]/u;
const write = process.argv.includes('--write');
const files = (root) => readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
  const file = join(root, entry.name);
  if (entry.isDirectory()) return files(file);
  return /\.(jsx|js)$/u.test(file) && !/\.test\./u.test(file) ? [file] : [];
});
const missing = new Set();
let count = 0;
for (const file of files('client/src')) {
  if (file.endsWith(`${sep}InstanceGate.jsx`) || file.endsWith(`${sep}AccountSettings.jsx`)) continue;
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const edits = [];
  traverse(ast, {
    StringLiteral(path) {
      const value = path.node.value;
      if (!han.test(value) || path.parentPath.isJSXAttribute()) return;
      if (!path.findParent((ancestor) => ancestor.isJSXExpressionContainer())) return;
      if (path.findParent((ancestor) => ancestor.isCallExpression() && ancestor.node.callee?.name === 't')) return;
      if (path.findParent((ancestor) => ancestor.isBinaryExpression())) return;
      if (path.findParent((ancestor) => ancestor.isCallExpression() && ancestor.node.callee?.property?.name === 'includes')) return;
      if (!Object.hasOwn(english, value)) { missing.add(value); return; }
      edits.push({ start: path.node.start, end: path.node.end, value });
    },
  });
  if (!edits.length) continue;
  let changed = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    changed = changed.slice(0, edit.start) + `t(${JSON.stringify(edit.value)})` + changed.slice(edit.end);
  }
  if (!/from ['"](?:\.\.?\/)+i18n\/index\.js['"]/u.test(changed)) {
    let path = relative(dirname(file), 'client/src/i18n/index.js').replaceAll(sep, '/');
    if (!path.startsWith('.')) path = `./${path}`;
    changed = `import { t } from '${path}';\n${changed}`;
  }
  if (write) writeFileSync(file, changed);
  count += edits.length;
}
process.stdout.write(`Translated expression occurrences: ${count}; missing distinct strings: ${missing.size}\n`);
