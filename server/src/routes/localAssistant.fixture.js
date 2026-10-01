import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleLocalAssistantRoute } from './localAssistant.js';

export function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0002_expand_playlist_count.sql', import.meta.url), 'utf8'));
  for (const file of ['0003_upgrade_assistant_model.sql', '0004_remove_system_playlists.sql',
    '0005_collection_identity.sql', '0006_ai_model_profiles.sql',
    '0007_default_ai_guidance.sql', '0008_assistant_memory.sql', '0009_ai_protocols.sql']) {
    sqlite.exec(readFileSync(new URL(`../../db/migrations-flaretune/${file}`, import.meta.url), 'utf8'));
  }
  const db = {
    prepare(sql) {
      const bindings = [];
      return {
        bind(...values) { bindings.push(...values); return this; },
        async first() { return sqlite.prepare(sql).get(...bindings) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...bindings) }; },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...bindings).changes } }; },
        runSync() {
          const result = sqlite.prepare(sql).run(...bindings);
          return { meta: { changes: result.changes } };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map((statement) => statement.runSync());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  for (const accountId of ['account-A', 'account-B']) {
    sqlite.prepare(`INSERT INTO accounts
      (account_id, username, display_name, role, status, created_at, updated_at)
      VALUES (?, ?, ?, 'member', 'active', 1, 1)`).run(accountId, accountId.toLowerCase(), accountId);
  }
  const session = (accountId) => ({ mode: 'normal', account: {
    accountId, username: accountId.toLowerCase(), displayName: accountId, role: 'member',
  } });
  const request = (path, method = 'GET', body) => new Request(`https://flare.test${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' } }),
  });
  const route = (path, method, body, actor = 'account-A', options = {}) => {
    const req = request(path, method, body);
    return handleLocalAssistantRoute(req, new URL(req.url), db, {}, session(actor),
      { DEEPSEEK_API_KEY: 'test-secret' }, options);
  };
  return { sqlite, db, route, request, session };
}
