import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';
import { messageForError, InstanceApiError } from './api.js';
import { validLocalPassword } from './state.js';

function nodesOf(view, predicate, found = []) {
  if (Array.isArray(view)) { view.forEach(child => nodesOf(child, predicate, found)); return found; }
  if (!view || typeof view !== 'object') return found;
  if (predicate(view)) found.push(view);
  nodesOf(view.props?.children, predicate, found);
  return found;
}

test('an expired setup proof can be reverified without losing the in-memory administrator draft', async () => {
  let proofNumber = 0, complete = 0;
  const requests = [];
  const harness = createBackgroundModuleHarness({
    file: new URL('./InstanceGate.jsx', import.meta.url), exportName: 'SetupPage',
    modules: {
      'lucide-react': {},
      './state.js': { validLocalPassword },
      './api.js': { messageForError,
        verifySetupSecret: async () => ({ proof: `proof-${++proofNumber}` }),
        setupInstance: async body => {
          requests.push(body);
          if (requests.length === 1) throw new InstanceApiError(403, 'invalid_setup');
        } },
      '../authNavigation.js': {}, '../utils/imageLoadRegistry.js': {},
      '../components/TuneWordmark.jsx': {}, '../components/GoogleLogin.jsx': {},
      '../components/SystemUpdatePanel.jsx': 'system-update-panel',
      './theme.js': {}, '../i18n/index.js': { t: text => text }, './instance.css': {},
    },
    globals: { queueMicrotask: fn => fn() },
  });
  const props = { onComplete: () => { complete++; } };
  let view = harness.render(props);
  const field = id => nodesOf(view, node => node.props?.id === id)[0];
  const submit = async () => {
    await nodesOf(view, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    view = harness.render(props);
  };
  field('setup-secret').props.onChange({ target: { value: 'setup-secret' } });
  view = harness.render(props);
  await submit();
  assert.equal(view.props.title, '创建管理员');
  for (const [id, value] of [['setup-username', 'new_admin'], ['setup-password', 'retained-password'], ['setup-confirm', 'retained-password']]) {
    field(id).props.onChange({ target: { value } });
  }
  view = harness.render(props);
  await submit();
  assert.equal(view.props.title, '验证初始化密钥');
  assert.equal(field('setup-secret').props.value, '', 'the setup secret is not retained after successful verification');
  assert.equal(nodesOf(view, node => node.type?.name === 'StatusMessage')[0].props.error, '初始化验证已失效，请重新验证密钥。');
  assert.equal(complete, 0);
  field('setup-secret').props.onChange({ target: { value: 'setup-secret' } });
  view = harness.render(props);
  await submit();
  assert.equal(field('setup-username').props.value, 'new_admin');
  assert.equal(field('setup-password').props.value, 'retained-password');
  assert.equal(field('setup-confirm').props.value, 'retained-password');
  await submit();
  assert.equal(complete, 1);
  assert.deepEqual(requests.map(request => request.proof), ['proof-1', 'proof-2']);
  assert.equal(requests[1].username, 'new_admin');
  assert.equal(requests[1].password, 'retained-password');
  harness.unmount();
});
