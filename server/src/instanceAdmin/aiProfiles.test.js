import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { assignAiProfile, createAiProfile, deleteAiProfile, listAiProfiles,
  resolveAiFeature, updateAiProfile } from './aiProfiles.js';
import { KNOWN_MIGRATIONS } from '../instance/schemaManifest.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_baseline.sql', '0002_expand_playlist_count.sql',
    '0003_upgrade_assistant_model.sql', '0004_remove_system_playlists.sql',
    '0005_collection_identity.sql', '0006_ai_model_profiles.sql',
    '0007_default_ai_guidance.sql', '0008_assistant_memory.sql']) {
    sqlite.exec(readFileSync(new URL(`../../db/migrations-flaretune/${name}`, import.meta.url), 'utf8'));
  }
  const migration = KNOWN_MIGRATIONS.find(({ version }) => version === 2);
  sqlite.prepare(`INSERT INTO ft_migrations (version, name, checksum, stage, state, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'completed', 1, 1)`).run(migration.version, migration.name,
    migration.checksum, migration.stage);
  sqlite.exec(`UPDATE ft_instance SET schema_version = 2, initialized_at = 1 WHERE id = 1;
    INSERT INTO accounts (account_id, username, display_name, role, status, created_at, updated_at)
      VALUES ('admin', 'owner', 'Owner', 'admin', 'active', 1, 1),
      ('member', 'reader', 'Reader', 'member', 'active', 1, 1);`);
  const salt = Buffer.alloc(16, 1).toString('base64url');
  const hash = Buffer.alloc(32, 2).toString('base64url');
  for (const id of ['admin', 'member']) {
    sqlite.prepare(`INSERT INTO account_credentials (account_id, kdf, kdf_version,
      kdf_params_json, salt, password_hash, must_change_password, updated_at)
      VALUES (?, 'pbkdf2-sha256-chain', 2, '{"iterations":100000,"rounds":6}', ?, ?, 0, 1)`)
      .run(id, salt, hash);
  }
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        _run() { return { success: true, meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = statements.map((entry) => entry._run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, sqlite, close: () => sqlite.close() };
}

const env = { SETUP_SECRET: 's'.repeat(48), DEEPSEEK_API_KEY: 'old-key' };
const profile = { name: 'DeepSeek 主方案', provider: 'deepseek', model: 'deepseek-chat',
  baseUrl: '', apiKey: 'new-private-key' };

test('admin creates encrypted profiles and assigns them without exposing keys', async () => {
  const { db, sqlite, close } = fixture();
  try {
    await assert.rejects(createAiProfile(db, 'member', profile, env), { code: 'forbidden' });
    const created = await createAiProfile(db, 'admin', profile, env);
    const stored = sqlite.prepare('SELECT * FROM ai_model_profiles WHERE id = ?').get(created.id);
    assert.doesNotMatch(JSON.stringify(stored), /new-private-key/);
    const listed = await listAiProfiles(db, 'admin', env);
    assert.equal(listed.profiles[0].hasKey, true);
    assert.doesNotMatch(JSON.stringify(listed), /new-private-key|encrypted_key|key_iv/);
    await assignAiProfile(db, 'admin', 'lyrics', created.id, 0);
    const resolved = await resolveAiFeature(db, 'lyrics',
      { ...env, DEEPSEEK_BASE_URL: 'https://old-proxy.example/v1' }, { temperature: 0.2 });
    assert.equal(resolved.config.model, 'deepseek-chat');
    assert.equal(resolved.env.DEEPSEEK_API_KEY, 'new-private-key');
    assert.equal(resolved.env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com');
    assert.equal(env.DEEPSEEK_API_KEY, 'old-key');
    await assert.rejects(deleteAiProfile(db, 'admin', created.id, 1),
      { code: 'ai_profile_in_use_or_conflict' });
    await assignAiProfile(db, 'admin', 'lyrics', null, 1);
    assert.equal(await resolveAiFeature(db, 'lyrics', env, {}), null);
    await deleteAiProfile(db, 'admin', created.id, 1);
    assert.equal((await listAiProfiles(db, 'admin', env)).profiles.length, 0);
  } finally { close(); }
});

test('profile updates preserve the key unless replaced and reject stale revisions', async () => {
  const { db, close } = fixture();
  try {
    const created = await createAiProfile(db, 'admin', profile, env);
    const updated = await updateAiProfile(db, 'admin', created.id,
      { ...profile, name: 'Updated', apiKey: '' }, 1, env);
    assert.equal(updated.revision, 2);
    await assert.rejects(updateAiProfile(db, 'admin', created.id,
      { ...profile, provider: 'openai', apiKey: '' }, 2, env),
    { code: 'ai_profile_key_required' });
    await assert.rejects(updateAiProfile(db, 'admin', created.id,
      { ...profile, baseUrl: 'https://another.example/v1', apiKey: '' }, 2, env),
    { code: 'ai_profile_key_required' });
    await assert.rejects(updateAiProfile(db, 'admin', created.id,
      { ...profile, apiKey: '' }, 1, env), { code: 'revision_conflict' });
    await assignAiProfile(db, 'admin', 'assistant', created.id, 0);
    assert.equal((await resolveAiFeature(db, 'assistant', env, {})).env.DEEPSEEK_API_KEY,
      'new-private-key');
    await updateAiProfile(db, 'admin', created.id, { ...profile, apiKey: 'replacement' },
      2, env);
    assert.equal((await resolveAiFeature(db, 'assistant', env, {})).env.DEEPSEEK_API_KEY,
      'replacement');
  } finally { close(); }
});

test('invalid endpoint and unavailable encryption root fail closed', async () => {
  const { db, close } = fixture();
  try {
    await assert.rejects(createAiProfile(db, 'admin', { ...profile,
      provider: 'compatible', baseUrl: 'http://localhost/v1' }, env),
    { code: 'invalid_ai_profile' });
    await assert.rejects(createAiProfile(db, 'admin', { ...profile,
      provider: 'compatible', baseUrl: 'https://[::1]/v1' }, env),
    { code: 'invalid_ai_profile' });
    await assert.rejects(createAiProfile(db, 'admin', profile, {}),
      { code: 'setup_secret_unavailable' });
    const created = await createAiProfile(db, 'admin', profile, env);
    await assignAiProfile(db, 'admin', 'lyrics', created.id, 0);
    const rotated = { SETUP_SECRET: 't'.repeat(48) };
    assert.equal((await listAiProfiles(db, 'admin', rotated)).profiles[0].hasKey, false);
    await assert.rejects(updateAiProfile(db, 'admin', created.id,
      { ...profile, apiKey: '' }, 1, rotated), { code: 'ai_profile_key_required' });
    await assert.rejects(resolveAiFeature(db, 'lyrics', rotated, {}),
      /AI_CREDENTIAL_UNAVAILABLE/);
    await updateAiProfile(db, 'admin', created.id, { ...profile, apiKey: 'reentered' }, 1, rotated);
    assert.equal((await listAiProfiles(db, 'admin', rotated)).profiles[0].hasKey, true);
    assert.equal((await resolveAiFeature(db, 'lyrics', rotated, {})).env.DEEPSEEK_API_KEY, 'reentered');
  } finally { close(); }
});
