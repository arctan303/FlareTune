import { pluginBuilds } from '../../../../shared/plugins/build.generated.js';

export function prepareAssistantModelFixture(sqlite, { accountId = 'account-A' } = {}) {
  const legacy = sqlite.prepare("SELECT provider,model,temperature FROM music_assistant_configs WHERE id='xiaoa'").get();
  const value = { schemaVersion: 1, selection: { providerId: null, model: legacy.model, supportsImages: false,
    generationOptions: { temperature: legacy.temperature }, providerBinding: JSON.stringify([legacy.provider, 'chat_completions', '']) } };
  sqlite.prepare(`INSERT OR REPLACE INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES ('plugin.data.assistant.instance.ai-model',?,1,1,?)`).run(JSON.stringify(value), accountId);
}

// Explicit test arrangement only. Production never bootstraps installations.
export function prepareAssistantPluginFixture(sqlite, { installed = true, modelInitialized = true } = {}) {
  if (installed) for (const id of ['ai-gateway', 'assistant']) {
    sqlite.prepare(`INSERT OR REPLACE INTO instance_settings(key,value_json,revision,updated_at,updated_by)
      VALUES (?,?,1,1,'account-A')`).run(`plugin.installation.${id}`, JSON.stringify({ installed: true, epoch: crypto.randomUUID() }));
  }
  if (modelInitialized) prepareAssistantModelFixture(sqlite);
  const initialized = new Set();
  return accountId => {
    const account = sqlite.prepare('SELECT role FROM accounts WHERE account_id=?').get(accountId);
    const tokenHash = `assistant-fixture-${accountId}`;
    if (!initialized.has(accountId)) {
      sqlite.prepare(`INSERT OR IGNORE INTO account_credentials(account_id,kdf,kdf_version,kdf_params_json,salt,password_hash,must_change_password,updated_at)
        VALUES (?,'pbkdf2-sha256-chain',2,'{"iterations":100000,"rounds":6}',?,?,0,1)`)
        .run(accountId, Buffer.alloc(16, 1).toString('base64url'), Buffer.alloc(32, 2).toString('base64url'));
      sqlite.prepare(`INSERT OR IGNORE INTO account_sessions(token_hash,account_id,mode,created_at,expires_at)
        VALUES (?,?,'normal',1,9999999999999)`).run(tokenHash, accountId);
      initialized.add(accountId);
    }
    return { mode: 'normal', tokenHash, account: { accountId, username: accountId.toLowerCase(), displayName: accountId, role: account.role } };
  };
}

export const assistantBuildHeaders = () => ({
  'X-FlareTune-Plugin-Build': pluginBuilds.find(item => item.id === 'assistant')?.sourceDigest || 'missing-assistant-build',
});
