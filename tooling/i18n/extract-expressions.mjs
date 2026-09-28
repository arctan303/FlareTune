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
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  traverse(ast, {
    StringLiteral(path) {
      if (!han.test(path.node.value) || path.parentPath.isJSXAttribute()) return;
      if (path.findParent((ancestor) => ancestor.isCallExpression() && ancestor.node.callee?.name === 't')) return;
      const jsx = path.findParent((ancestor) => ancestor.isJSXExpressionContainer());
      if (!jsx) return;
      const value = path.node.value;
      if (!found.has(value)) found.set(value, []);
      found.get(value).push(`${file}:${path.node.loc.start.line}`);
    },
  });
}
for (const [value, locations] of found) process.stdout.write(`${JSON.stringify(value)}\t${locations[0]}\n`);
