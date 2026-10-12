import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import english from '../../client/src/i18n/en.js';
import { UI_LANGUAGES } from '../../shared/uiLanguages.js';

function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(js|jsx)$/u.test(file) && !/\.test\./u.test(file) && !file.includes(`${join('client', 'src', 'i18n')}${process.platform === 'win32' ? '\\' : '/'}`)
      ? [file] : [];
  });
}

const placeholders = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1]).sort().join(',');
const forms = value => typeof value === 'string' ? [value] : Object.values(value || {});
const missing = [];
for (const {id} of UI_LANGUAGES.filter(item => !['zh','en'].includes(item.id))) {
  const catalog = JSON.parse(readFileSync(`client/src/i18n/locales/${id}.json`,'utf8'));
  for (const key of new Set([...Object.keys(english),...Object.keys(catalog)])) {
    if (!Object.hasOwn(english,key) || !Object.hasOwn(catalog,key)) missing.push(`${id}: key mismatch ${key}`);
    else if (!forms(catalog[key]).length || forms(catalog[key]).some(value => typeof value !== 'string' || !value.trim() || placeholders(value) !== placeholders(key))) missing.push(`${id}: invalid value/placeholders ${key}`);
  }
}
for (const file of [...sourceFiles('client/src'), ...sourceFiles('demo')]) {
  const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
  traverse(ast, {
    TemplateLiteral(path) {
      if (!path.node.quasis.some(part => /[\u3400-\u9fff]/u.test(part.value.cooked))) return;
      // Logs and shader/HTML source are not UI messages. Catch cataloged dynamic
      // messages whose translations exist but were never called at runtime.
      const call = path.findParent(parent => parent.isCallExpression());
      if (call?.node.callee.type === 'MemberExpression' && call.node.callee.object.name === 'console') return;
      const key = path.node.quasis.map((part, index) => part.value.cooked
        + (index < path.node.expressions.length ? `{p${index}}` : '')).join('');
      if (Object.hasOwn(english, key)) missing.push(`${file}:${path.node.loc.start.line}: untranslated dynamic message ${key}`);
    },
    CallExpression(path) {
      if (path.node.callee.type !== 'Identifier' || path.node.callee.name !== 't') return;
      const key = path.node.arguments[0];
      if (key?.type !== 'StringLiteral' || !/[\u3400-\u9fff]/u.test(key.value)) return;
      if (!Object.hasOwn(english, key.value)) missing.push(`${file}:${key.loc.start.line}: missing ${JSON.stringify(key.value)}`);
      else if (forms(english[key.value]).some(value => placeholders(value) !== placeholders(key.value))) {
        missing.push(`${file}:${key.loc.start.line}: placeholders differ for ${JSON.stringify(key.value)}`);
      }
    },
  });
}
for (const item of missing) process.stderr.write(`${item}\n`);
process.stdout.write(`${missing.length} catalog errors\n`);
if (missing.length) process.exitCode = 1;
