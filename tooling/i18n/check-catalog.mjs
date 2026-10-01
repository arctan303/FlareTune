import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import english from '../../client/src/i18n/en.js';

function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(js|jsx)$/u.test(file) && !/\.test\./u.test(file) && !file.includes(`${join('client', 'src', 'i18n')}${process.platform === 'win32' ? '\\' : '/'}`)
      ? [file] : [];
  });
}

const placeholders = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1]).sort().join(',');
const missing = [];
for (const file of sourceFiles('client/src')) {
  const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
  traverse(ast, {
    CallExpression(path) {
      if (path.node.callee.type !== 'Identifier' || path.node.callee.name !== 't') return;
      const key = path.node.arguments[0];
      if (key?.type !== 'StringLiteral' || !/[\u3400-\u9fff]/u.test(key.value)) return;
      if (!Object.hasOwn(english, key.value)) missing.push(`${file}:${key.loc.start.line}: missing ${JSON.stringify(key.value)}`);
      else if (placeholders(english[key.value]) !== placeholders(key.value)) {
        missing.push(`${file}:${key.loc.start.line}: placeholders differ for ${JSON.stringify(key.value)}`);
      }
    },
  });
}
for (const item of missing) process.stderr.write(`${item}\n`);
process.stdout.write(`${missing.length} catalog errors\n`);
if (missing.length) process.exitCode = 1;
