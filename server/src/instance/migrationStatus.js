import { hasHotpathObjects } from './hotpathSchema.js';

const supplements = [
  ['ai_protocols', ['ai_profile_protocols']],
  ['user_images', ['user_images', 'user_image_refs']],
  ['ai_feature_models', ['ai_feature_models']],
  ['google_login', ['google_login_config', 'account_google_bindings', 'google_login_transactions']],
];

export async function getSupplementalMigrationStatus(db) {
  const result = await db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger', 'index')").all();
  const names = new Set((result.results || []).map(row => row.name));
  const supplementalMigrations = supplements.map(([id, tables]) => ({ id, ready: tables.every(name => names.has(name)) }));
  supplementalMigrations.push({ id: 'hotpath_counts', ready: hasHotpathObjects(result.results) });
  return { supplementalPending: supplementalMigrations.some(item => !item.ready), supplementalMigrations };
}
