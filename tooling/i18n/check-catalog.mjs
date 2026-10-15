import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import english from '../../client/src/i18n/en.js';
import { UI_LANGUAGES } from '../../shared/uiLanguages.js';
import { ASSISTANT_TOOL_TEXT_KEYS } from '../../client/src/assistantToolText.js';
import { REQUEST_ERROR_KEYS } from '../../client/src/i18n/requestErrors.js';

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
const han = /[\u3400-\u9fff]/u;
const staticKeys = node => {
  if (!node) return [];
  if (node.type === 'StringLiteral') return [node];
  if (node.type === 'ConditionalExpression') return [...staticKeys(node.consequent), ...staticKeys(node.alternate)];
  if (node.type === 'LogicalExpression') return [...staticKeys(node.left), ...staticKeys(node.right)];
  return [];
};
const checkKey = (key, location) => {
  if (!han.test(key)) return;
  if (!Object.hasOwn(english, key)) missing.push(`${location}: missing ${JSON.stringify(key)}`);
  else if (forms(english[key]).some(value => typeof value !== 'string' || placeholders(value) !== placeholders(key))) {
    missing.push(`${location}: placeholders differ for ${JSON.stringify(key)}`);
  }
};
for (const key of ASSISTANT_TOOL_TEXT_KEYS) checkKey(key, 'assistant tool text');
for (const key of REQUEST_ERROR_KEYS) checkKey(key, 'request error text');
for (const [key, value] of Object.entries(english)) {
  if (!forms(value).length || forms(value).some(form => typeof form !== 'string' || !form.trim() || placeholders(form) !== placeholders(key))) {
    missing.push(`en: invalid value/placeholders ${key}`);
  }
}
for (const {id} of UI_LANGUAGES.filter(item => !['zh','en'].includes(item.id))) {
  const catalog = JSON.parse(readFileSync(`client/src/i18n/locales/${id}.json`,'utf8'));
  for (const key of new Set([...Object.keys(english),...Object.keys(catalog)])) {
    if (!Object.hasOwn(english,key) || !Object.hasOwn(catalog,key)) missing.push(`${id}: key mismatch ${key}`);
    else if (!forms(catalog[key]).length || forms(catalog[key]).some(value => typeof value !== 'string' || !value.trim() || placeholders(value) !== placeholders(key))) missing.push(`${id}: invalid value/placeholders ${key}`);
  }
}
for (const file of [...sourceFiles('client/src'), ...sourceFiles('demo')]) {
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  traverse(ast, {
    JSXText(path) {
      if (han.test(path.node.value)) missing.push(`${file}:${path.node.loc.start.line}: untranslated JSX text ${JSON.stringify(path.node.value.trim())}`);
    },
    JSXAttribute(path) {
      const element = path.parentPath.node.name;
      if (element.type !== 'JSXIdentifier' || !/^[a-z]/u.test(element.name)) return;
      if (!['title', 'alt', 'placeholder', 'aria-label', 'aria-valuetext', 'aria-description'].includes(path.node.name.name)) return;
      if (path.node.value?.type === 'StringLiteral' && han.test(path.node.value.value)) {
        missing.push(`${file}:${path.node.loc.start.line}: untranslated ${path.node.name.name}`);
      }
    },
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
      const callee = path.node.callee;
      const key = path.node.arguments[0];
      if (callee.type === 'Identifier' && callee.name === 't') {
        for (const item of staticKeys(key)) checkKey(item.value, `${file}:${item.loc.start.line}`);
      } else if ((callee.type === 'Identifier' && ['confirm', 'alert', 'prompt'].includes(callee.name))
        || (callee.type === 'MemberExpression' && ['window', 'globalThis'].includes(callee.object.name)
          && ['confirm', 'alert', 'prompt'].includes(callee.property.name))) {
        if (key && han.test(source.slice(key.start, key.end))
          && !(key.type === 'CallExpression' && key.callee.name === 't')) {
          missing.push(`${file}:${key.loc.start.line}: untranslated native dialog`);
        }
      }
    },
  });
}
for (const item of missing) process.stderr.write(`${item}\n`);
process.stdout.write(`${missing.length} catalog errors\n`);
if (missing.length) process.exitCode = 1;
