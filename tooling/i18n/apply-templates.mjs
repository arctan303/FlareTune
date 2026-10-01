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
let count = 0;
const missing = new Set();
for (const file of files('client/src')) {
  if (file.endsWith(`${sep}InstanceGate.jsx`) || file.endsWith(`${sep}AccountSettings.jsx`)) continue;
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const edits = [];
  traverse(ast, {
    TemplateLiteral(path) {
      if (!path.findParent((ancestor) => ancestor.isJSXExpressionContainer()) || path.parentPath.isTaggedTemplateExpression()) return;
      const node = path.node;
      const key = node.quasis.map((part, index) => `${part.value.cooked ?? part.value.raw}${index < node.expressions.length ? `{p${index}}` : ''}`).join('');
      if (!han.test(key)) return;
      if (!Object.hasOwn(english, key)) { missing.add(key); return; }
      const values = node.expressions.map((expression, index) => `p${index}: (${source.slice(expression.start, expression.end)})`).join(', ');
      edits.push({ start: node.start, end: node.end, replacement: `t(${JSON.stringify(key)}, { ${values} })` });
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
  count += edits.length;
}
process.stdout.write(`Translated template occurrences: ${count}; missing distinct strings: ${missing.size}\n`);
