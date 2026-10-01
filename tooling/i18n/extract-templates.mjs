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
    TemplateLiteral(path) {
      if (!path.findParent((ancestor) => ancestor.isJSXExpressionContainer())) return;
      const key = path.node.quasis.map((part, index) => `${part.value.cooked ?? part.value.raw}${index < path.node.expressions.length ? `{p${index}}` : ''}`).join('');
      if (!han.test(key)) return;
      if (!found.has(key)) found.set(key, []);
      found.get(key).push(`${file}:${path.node.loc.start.line}`);
    },
  });
}
for (const [key, locations] of found) process.stdout.write(`${JSON.stringify(key)}\t${locations[0]}\n`);
