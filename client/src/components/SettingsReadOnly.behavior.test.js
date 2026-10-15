import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const module = { exports: {} }; cache.set(name,module.exports);
  vm.runInNewContext(transformSync(readFileSync(new URL(name,import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code, {
    module, exports:module.exports, require: id => id==='react' ? React : load(id),
  });
  cache.set(name,module.exports);return module.exports;
}
const { SettingsReadOnlyContext, SettingsInput, SettingsWriteButton } = load('./SettingsReadOnly.jsx');
const { SettingsButton, SettingsToggle } = load('./SettingsControls.jsx');
const html = (Component, props, readOnly) => renderToStaticMarkup(React.createElement(SettingsReadOnlyContext.Provider,{value:readOnly},React.createElement(Component,props)));
test('ordinary instances retain editable settings and enabled save actions',()=>{
  for(const Component of [SettingsInput,SettingsWriteButton,SettingsToggle]) assert.doesNotMatch(html(Component,{},false),/disabled=""/);
  assert.doesNotMatch(html(SettingsButton,{type:'submit'},false),/disabled=""/);
});
test('demo policy disables configuration writes while preserving inspection and local preferences',()=>{
  for(const Component of [SettingsInput,SettingsWriteButton,SettingsToggle]) assert.match(html(Component,{},true),/disabled=""/);
  assert.match(html(SettingsButton,{type:'submit'},true),/disabled=""/);
  assert.match(html(SettingsButton,{variant:'danger'},true),/disabled=""/);
  assert.doesNotMatch(html(SettingsButton,{children:'View configuration'},true),/disabled=""/);
  assert.doesNotMatch(html(SettingsInput,{allowInReadOnly:true},true),/disabled=""/);
});
