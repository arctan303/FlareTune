import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../subsonic/test-support.js';
import { getAdminSettings, readDefinedSettings, updateDefinedSetting, validateSetting } from './settings.js';
import { InstanceAdminError } from './common.js';

test('core settings do not query optional plugin configuration', async t => {
  const f = await fixture(); t.after(f.close);
  const actor = f.signed.session.account.accountId;
  f.db.queries.length = 0;
  const overview = await getAdminSettings(f.db, actor);
  assert.deepEqual(Object.keys(overview.settings), ['instance.name', 'cors.allowed_origins']);
  assert.ok(f.db.queries.every(sql => !/AI_Assistants|music_assistant_configs/u.test(sql)));
  assert.throws(() => validateSetting('lyrics.ai', {}), { code: 'unknown_setting' });
});

test('caller-owned settings preserve admin authority, CAS, audit and previous-value validation', async t => {
  const f = await fixture(); t.after(f.close);
  const actor = f.signed.session.account.accountId, key = 'plugin.fixture.preference';
  const definition = { defaultValue: 'initial', validate(value) {
    if (typeof value !== 'string') throw new InstanceAdminError('invalid_setting', 400);
    return value;
  }, validatePrevious(next, previous) {
    if (previous === 'saved' && next === 'forbidden') throw new InstanceAdminError('invalid_setting', 400);
  } };
  assert.deepEqual((await readDefinedSettings(f.db, actor, { [key]: definition }))[key], { value: 'initial', revision: 0 });
  await assert.rejects(updateDefinedSetting(f.db, 'member', key, 'saved', 0, definition), { code: 'forbidden' });
  const saved = await updateDefinedSetting(f.db, actor, key, 'saved', 0, definition);
  assert.equal(saved.revision, 1);
  await assert.rejects(updateDefinedSetting(f.db, actor, key, 'stale', 0, definition), { code: 'revision_conflict' });
  await assert.rejects(updateDefinedSetting(f.db, actor, key, 'forbidden', 1, definition), { code: 'invalid_setting' });
  assert.deepEqual((await readDefinedSettings(f.db, actor, { [key]: definition }))[key], { value: 'saved', revision: 1 });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='setting.update' AND target_id=?").get(key).n, 1);
});
