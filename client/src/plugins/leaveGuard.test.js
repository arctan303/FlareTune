import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPluginLeaveGuard } from './leaveGuard.js';
import { syncBrowserHistory, parsePathname } from '../utils/navigation.js';

test('a rejected plugin leave never changes URL, history or emits a route update', () => {
  const previousWindow = globalThis.window, previousEvent = globalThis.CustomEvent;
  const actions = [];
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  globalThis.window = { location: { pathname: '/plugins/lyrics-workbench/current', search: '?song=one' },
    history: { state: {}, replaceState: () => actions.push('replace'), pushState: () => actions.push('push') },
    dispatchEvent: () => actions.push('event') };
  let allow = false;
  const dispose = registerPluginLeaveGuard(() => allow);
  try {
    syncBrowserHistory('/settings/appearance'); assert.deepEqual(actions, []);
    allow = true; syncBrowserHistory('/settings/appearance'); assert.ok(actions.includes('push')); assert.ok(actions.includes('event'));
    actions.length = 0; allow = false; dispose(); syncBrowserHistory('/library'); assert.ok(actions.includes('push'));
  } finally { dispose(); globalThis.window = previousWindow; globalThis.CustomEvent = previousEvent; }
});

test('resource identity survives canonical plugin sections and legacy external song links', () => {
  assert.deepEqual(parsePathname('/lyrics/yt%3Aabc/tools'), { type: 'page', page: 'plugin', pluginId: 'lyrics-workbench', pluginPage: 'tools', songId: 'yt:abc' });
  assert.deepEqual(parsePathname('/plugins/lyrics-workbench/candidates?song=yt%3Aabc'), { type: 'page', page: 'plugin', pluginId: 'lyrics-workbench', pluginPage: 'candidates', songId: 'yt:abc' });
});
