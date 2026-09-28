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
const findings = [];
for (const file of files('client/src')) {
  if (file.startsWith(join('client', 'src', 'i18n'))) continue;
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  traverse(ast, {
    StringLiteral(path) {
      if (!han.test(path.node.value) || path.parentPath.isJSXAttribute()) return;
      if (path.findParent((ancestor) => ancestor.isCallExpression() && ancestor.node.callee?.name === 't')) return;
      findings.push([file, path.node.loc.start.line, path.node.value]);
    },
    TemplateLiteral(path) {
      const key = path.node.quasis.map((part, index) => `${part.value.cooked ?? part.value.raw}${index < path.node.expressions.length ? `{p${index}}` : ''}`).join('');
      if (!han.test(key)) return;
      findings.push([file, path.node.loc.start.line, key]);
    },
  });
}
if (process.argv.includes('--counts')) {
  const counts = new Map();
  for (const [file] of findings) counts.set(file, (counts.get(file) || 0) + 1);
  for (const [file, count] of [...counts].sort((a, b) => b[1] - a[1])) process.stdout.write(`${count}\t${file}\n`);
} else for (const [file, line, value] of findings) process.stdout.write(`${file}:${line}\t${JSON.stringify(value)}\n`);
