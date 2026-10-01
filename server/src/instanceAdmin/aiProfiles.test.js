import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { assignAiProfile, createAiProfile, deleteAiProfile, listAiProfiles,
  listAiModels, resolveAiFeature, updateAiProfile } from './aiProfiles.js';
import { KNOWN_MIGRATIONS } from '../instance/schemaManifest.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_baseline.sql', '0002_expand_playlist_count.sql',
    '0003_upgrade_assistant_model.sql', '0004_remove_system_playlists.sql',
    '0005_collection_identity.sql', '0006_ai_model_profiles.sql',
    '0007_default_ai_guidance.sql', '0008_assistant_memory.sql', '0009_ai_protocols.sql', '0011_ai_feature_models.sql']) {
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

test('new source presets are independent from legacy protocols and retain stable IDs/keys', async () => {
  const { db, sqlite, close } = fixture();
  try {
    const legacy = await createAiProfile(db, 'admin', { ...profile, provider: 'openai' }, env);
    const modern = await createAiProfile(db, 'admin', { ...profile, provider: undefined, source: 'openai' }, env);
    assert.equal(legacy.protocol, 'chat_completions');
    assert.equal(modern.protocol, 'responses');
    const encrypted = sqlite.prepare('SELECT encrypted_key FROM ai_model_profiles WHERE id = ?').get(legacy.id).encrypted_key;
    sqlite.prepare('DELETE FROM ai_profile_protocols WHERE profile_id = ?').run(legacy.id);
    const listed = await listAiProfiles(db, 'admin', env);
    assert.equal(listed.profiles.find((item) => item.id === legacy.id).protocol, 'chat_completions');
    await updateAiProfile(db, 'admin', legacy.id, { ...profile, source: 'openai', protocol: 'chat_completions',
      baseUrl: 'https://api.openai.com/v1/', apiKey: '' }, 1, env);
    assert.equal(sqlite.prepare('SELECT encrypted_key FROM ai_model_profiles WHERE id = ?').get(legacy.id).encrypted_key, encrypted);
    assert.equal((await listAiProfiles(db, 'admin', env)).profiles.length, 2);
  } finally { close(); }
});

test('protocol changes require re-entering keys; stale updates cannot alter protocol metadata', async () => {
  const { db, sqlite, close } = fixture();
  try {
    const created = await createAiProfile(db, 'admin', { ...profile, source: 'openai', protocol: 'responses' }, env);
    await assert.rejects(updateAiProfile(db, 'admin', created.id, { ...profile, source: 'openai',
      protocol: 'anthropic_messages', baseUrl: 'https://api.example/v1', apiKey: '' }, 1, env), { code: 'ai_profile_key_required' });
    await assert.rejects(updateAiProfile(db, 'admin', created.id, { ...profile, source: 'openai',
      protocol: 'anthropic_messages', baseUrl: 'https://api.example/v1' }, 2, env), { code: 'revision_conflict' });
    assert.equal(sqlite.prepare('SELECT protocol FROM ai_profile_protocols WHERE profile_id = ?').get(created.id).protocol, 'responses');
    for (const generationOptions of [{ tools: [] }, { temperature: '1' }, { maxOutputTokens: 0 }]) {
      await assert.rejects(createAiProfile(db, 'admin', { ...profile, generationOptions }, env), { code: 'invalid_ai_profile' });
    }
  } finally { close(); }
});

test('deployment-bound legacy configuration works before both profile tables exist, but partial schema fails closed', async () => {
  const { db, sqlite, close } = fixture();
  try {
    sqlite.exec('DROP TABLE ai_profile_protocols; DROP TABLE ai_feature_assignments');
    await assert.rejects(resolveAiFeature(db, 'assistant', env, { provider: 'deepseek', model: 'fixture' }));
    sqlite.exec('DROP TABLE ai_model_profiles');
    assert.equal(await resolveAiFeature(db, 'assistant', env, { provider: 'deepseek', model: 'fixture' }), null);
  } finally { close(); }
});

test('Anthropic and custom Gemini sources resolve their own bound credentials/options', async () => {
  const { db, close } = fixture();
  try {
    for (const [source, protocol, baseUrl] of [['anthropic', 'anthropic_messages', ''],
      ['custom', 'gemini_native', 'https://proxy.example/v1beta']]) {
      const created = await createAiProfile(db, 'admin', { ...profile, source, protocol, baseUrl,
        generationOptions: { maxOutputTokens: 8192, reasoningEffort: 'low' } }, env);
      await assignAiProfile(db, 'admin', 'assistant', created.id, source === 'anthropic' ? 0 : 1);
      const resolved = await resolveAiFeature(db, 'assistant', env, { temperature: 0.8 });
      assert.equal(resolved.config.source, source);
      assert.equal(resolved.config.protocol, protocol);
      assert.equal(resolved.config.generationOptions.maxOutputTokens, 8192);
      assert.equal(resolved.env.AI_PROFILE_API_KEY, profile.apiKey);
      assert.equal(resolved.env.AI_PROFILE_BASE_URL, baseUrl || 'https://api.anthropic.com/v1');
      assert.doesNotMatch(JSON.stringify(await listAiProfiles(db, 'admin', env)), /new-private-key|encrypted_key|key_iv/);
    }
  } finally { close(); }
});

test('model discovery denies members and cannot forward a stored key to changed routes', async (t) => {
  const { db, close } = fixture();
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    fetched += 1;
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, `Bearer ${profile.apiKey}`);
    return Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-flash' }, { id: 'invalid\nmodel' }] });
  });
  try {
    const created = await createAiProfile(db, 'admin', profile, env);
    const input = { ...profile, apiKey: '', profileId: created.id, expectedRevision: 1 };
    await assert.rejects(listAiModels(db, 'member', input, env), { code: 'forbidden' });
    await assert.rejects(listAiModels(db, 'admin', { ...input, expectedRevision: 2 }, env), { code: 'revision_conflict' });
    for (const patch of [{ baseUrl: 'https://other.example/v1' }, { protocol: 'responses' }, { source: 'openai' }]) {
      await assert.rejects(listAiModels(db, 'admin', { ...input, ...patch }, env), { code: 'ai_profile_key_required' });
    }
    assert.equal(fetched, 0);
    assert.deepEqual(await listAiModels(db, 'admin', input, env), { models: ['deepseek-flash'], hasMore: false, verifiedCapabilities: false });
  } finally { close(); }
});

test('legacy profiles continue working before protocol migration; new writes roll back', async () => {
  const { db, sqlite, close } = fixture();
  try {
    const created = await createAiProfile(db, 'admin', profile, env);
    await assignAiProfile(db, 'admin', 'assistant', created.id, 0);
    sqlite.exec('DROP TABLE ai_profile_protocols');
    const resolved = await resolveAiFeature(db, 'assistant', env, {});
    assert.equal(resolved.config.protocol, 'chat_completions');
    assert.equal(resolved.env.AI_PROFILE_API_KEY, profile.apiKey);
    await assert.rejects(createAiProfile(db, 'admin', { ...profile, source: 'openai' }, env));
    assert.equal((await listAiProfiles(db, 'admin', env)).profiles.length, 1);
  } finally { close(); }
});
