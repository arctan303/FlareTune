import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDevelopmentKv, developmentVersionId, developmentKvBinding } from './dev-kv-binding.mjs';
const id = '00000000-0000-4000-8000-000000000006';
const namespace = '00000000000000000000000000000006';
test('development CI preserves only the named existing YTM KV without printing other variables', () => {
  const calls = [];
  const result = resolveDevelopmentKv({ read: args => { calls.push(args);
    return args[0] === 'deployments' ? [{ created_on: '2026-11-06', versions: [{ version_id: id, percentage: 100 }] }]
      : { resources: { bindings: [{ name: 'OTHER_SECRET', type: 'plain_text', text: 'not-to-be-printed' },
        { name: 'YTM_KV', type: 'kv_namespace', namespace_id: namespace }] } };
  } });
  assert.equal(result, namespace);
  assert.deepEqual(calls, [['deployments', 'list'], ['versions', 'view', id]]);
});
test('missing KV, wrong resource, invalid ID and mixed rollouts fail closed', () => {
  assert.throws(() => developmentKvBinding({ resources: { bindings: [] } }));
  assert.throws(() => developmentKvBinding({ resources: { bindings: [{ name: 'YTM_KV', type: 'r2_bucket', namespace_id: namespace }] } }));
  assert.throws(() => developmentVersionId([{ versions: [{ version_id: id, percentage: 50 }, { version_id: id, percentage: 50 }] }]));
  assert.throws(() => resolveDevelopmentKv({ configured: 'not-a-namespace', read: () => assert.fail() }));
});
test('an explicitly supplied development KV skips remote metadata reads', () => {
  assert.equal(resolveDevelopmentKv({ configured: namespace, read: () => assert.fail() }), namespace);
});
