import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

const han = /[\u3400-\u9fff]/u;
const files = (root) => readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
  const file = join(root, entry.name);
  if (entry.isDirectory()) return files(file);
  return /\.(jsx|js)$/u.test(file) && !/\.test\./u.test(file) ? [file] : [];
});
const found = new Map();
for (const file of files('client/src')) {
  const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
  traverse(ast, {
    CallExpression(path) {
      if (!['showToast', 'setError', 'setErrorMessage', 'setStatusMessage', 'setMessage'].includes(path.node.callee?.name)) return;
      const argument = path.node.arguments[0];
      if (!argument) return;
      let key;
      if (argument.type === 'StringLiteral') key = argument.value;
      if (argument.type === 'TemplateLiteral') key = argument.quasis.map((part, index) => `${part.value.cooked ?? part.value.raw}${index < argument.expressions.length ? `{p${index}}` : ''}`).join('');
      if (!key || !han.test(key)) return;
      if (!found.has(key)) found.set(key, []);
      found.get(key).push(`${file}:${argument.loc.start.line}`);
    },
  });
}
for (const [key, locations] of found) process.stdout.write(`${JSON.stringify(key)}\t${locations[0]}\n`);
