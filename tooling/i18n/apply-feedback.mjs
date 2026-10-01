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
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const edits = [];
  traverse(ast, {
    CallExpression(path) {
      if (!['showToast', 'setError', 'setErrorMessage', 'setStatusMessage', 'setMessage'].includes(path.node.callee?.name)) return;
      if ((file.endsWith(`${sep}AccountSettings.jsx`) || file.endsWith(`${sep}InstanceGate.jsx`)) && path.node.callee.name !== 'showToast') return;
      const argument = path.node.arguments[0];
      if (!argument) return;
      let key;
      let values;
      if (argument.type === 'StringLiteral') key = argument.value;
      if (argument.type === 'TemplateLiteral') {
        key = argument.quasis.map((part, index) => `${part.value.cooked ?? part.value.raw}${index < argument.expressions.length ? `{p${index}}` : ''}`).join('');
        values = argument.expressions.map((expression, index) => `p${index}: (${source.slice(expression.start, expression.end)})`).join(', ');
      }
      if (!key || !han.test(key)) return;
      if (!Object.hasOwn(english, key)) { missing.add(key); return; }
      edits.push({ start: argument.start, end: argument.end,
        replacement: `t(${JSON.stringify(key)}${values === undefined ? '' : `, { ${values} }`})` });
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
process.stdout.write(`Translated feedback occurrences: ${count}; missing distinct strings: ${missing.size}\n`);
