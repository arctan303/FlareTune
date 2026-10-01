import {
  InstanceAdminError, atomic, changed, currentTime, requireActiveAdmin, statement, validateRevision,
} from './common.js';
import { DEFAULT_LYRIC_AI_CONFIG, normalizeLyricAiConfig } from '../utils/lyricAiConfig.js';
import { DEFAULT_ASSISTANT_PERSONA, DEFAULT_ASSISTANT_RULES } from '../utils/aiPromptDefaults.js';

export const DEFAULT_SETTINGS = Object.freeze({
  'instance.name': 'FlareTune',
  'cors.allowed_origins': [],
  'ai.compatible_api_url': '',
  'lyrics.ai': DEFAULT_LYRIC_AI_CONFIG,
  'assistant.images_enabled': false,
});

const knownKeys = new Set(Object.keys(DEFAULT_SETTINGS));
const assistantFields = Object.freeze([
  'name', 'description', 'avatar_icon', 'persona', 'welcome_message',
  'system_rules', 'provider', 'model', 'temperature',
]);

function validText(value, max, min = 1) {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}

function exactHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash && parsed.pathname === '/' && parsed.origin === value;
  } catch {
    return false;
  }
}

export function validateSetting(key, value) {
  if (!knownKeys.has(key)) throw new InstanceAdminError('unknown_setting', 400);
  if (key === 'assistant.images_enabled' && typeof value === 'boolean') return value;
  if (key === 'lyrics.ai') {
    try { return normalizeLyricAiConfig(value); }
    catch { throw new InstanceAdminError('invalid_setting', 400); }
  }
  if (key === 'instance.name' && validText(value, 80)) return value.trim();
  if (key === 'cors.allowed_origins' && Array.isArray(value) && value.length <= 32
    && value.every(exactHttpsOrigin) && new Set(value).size === value.length) return value;
  if (key === 'ai.compatible_api_url' && (value === '' || (typeof value === 'string'
    && value.length <= 2048 && (() => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
      } catch { return false; }
    })()))) return value;
  throw new InstanceAdminError('invalid_setting', 400);
}

export function validateAssistantConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some((key) => !assistantFields.includes(key))) {
    throw new InstanceAdminError('invalid_assistant_setting', 400);
  }
  const lengths = { name: 80, description: 500, avatar_icon: 80, persona: 12000,
    welcome_message: 1000, system_rules: 24000, provider: 80, model: 160 };
  for (const [key, max] of Object.entries(lengths)) {
    if (!validText(config[key], max)) throw new InstanceAdminError('invalid_assistant_setting', 400);
  }
  if (typeof config.temperature !== 'number' || !Number.isFinite(config.temperature)
    || config.temperature < 0 || config.temperature > 2) throw new InstanceAdminError('invalid_assistant_setting', 400);
  return config;
}

export async function getAdminSettings(db, actorAccountId, { aiApiKeyConfigured = null } = {}) {
  await requireActiveAdmin(db, actorAccountId);
  const rows = await db.prepare(`SELECT key, value_json, revision FROM instance_settings
    WHERE key IN ('instance.name', 'cors.allowed_origins', 'ai.compatible_api_url', 'lyrics.ai', 'assistant.images_enabled')`).all();
  const settings = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) settings[key] = { value: fallback, revision: 0 };
  for (const row of rows?.results ?? []) {
    if (!knownKeys.has(row.key)) continue;
    try {
      settings[row.key] = { value: validateSetting(row.key, JSON.parse(row.value_json)), revision: row.revision };
    } catch {
      throw new InstanceAdminError('setting_corrupt', 503);
    }
  }
  if (settings['lyrics.ai'].revision === 0) {
    const legacy = await db.prepare(`SELECT provider, model, temperature, system_prompt
      FROM AI_Assistants WHERE id = 'lyric_translator'`).first();
    if (legacy?.provider && legacy?.model) {
      settings['lyrics.ai'].value = normalizeLyricAiConfig({
        ...DEFAULT_LYRIC_AI_CONFIG,
        provider: legacy.provider,
        model: legacy.model,
        temperature: legacy.temperature ?? 0.2,
        styleRules: DEFAULT_LYRIC_AI_CONFIG.styleRules,
      });
    }
  }
  const assistant = await db.prepare(`SELECT name, description, avatar_icon, persona, welcome_message,
    system_rules, provider, model, temperature, revision FROM music_assistant_configs WHERE id = 'xiaoa'`).first();
  if (!assistant) throw new InstanceAdminError('assistant_config_missing', 503);
  return { settings, assistant, defaults: {
    assistant: { persona: DEFAULT_ASSISTANT_PERSONA, system_rules: DEFAULT_ASSISTANT_RULES },
    lyrics: { styleRules: DEFAULT_LYRIC_AI_CONFIG.styleRules },
  }, secrets: { aiApiKeyConfigured } };
}

export async function updateAdminSetting(db, actorAccountId, key, value, expectedRevision, now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  validateRevision(expectedRevision, { allowZero: true });
  const safeValue = validateSetting(key, value);
  currentTime(now);
  const json = JSON.stringify(safeValue);
  const mutation = expectedRevision === 0
    ? statement(db, `INSERT INTO instance_settings (key, value_json, revision, updated_at, updated_by)
        SELECT ?, ?, 1, ?, ? WHERE EXISTS
          (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')
        ON CONFLICT(key) DO NOTHING`, key, json, now, actor.account_id, actor.account_id)
    : statement(db, `UPDATE instance_settings SET value_json = ?, revision = revision + 1,
        updated_at = ?, updated_by = ? WHERE key = ? AND revision = ?
        AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    json, now, actor.account_id, key, expectedRevision, actor.account_id);
  const [result] = await atomic(db, [
    mutation,
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'setting.update', 'setting', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, key, now),
  ]);
  if (!changed(result)) throw new InstanceAdminError('revision_conflict', 409);
  return { key, value: safeValue, revision: expectedRevision + 1 };
}

export async function updateAssistantConfig(db, actorAccountId, patch, expectedRevision, now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  validateRevision(expectedRevision);
  currentTime(now);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.keys(patch).length === 0 || Object.keys(patch).some((key) => !assistantFields.includes(key))) {
    throw new InstanceAdminError('invalid_assistant_setting', 400);
  }
  const existing = await db.prepare(`SELECT name, description, avatar_icon, persona, welcome_message,
    system_rules, provider, model, temperature, revision FROM music_assistant_configs WHERE id = 'xiaoa'`).first();
  if (!existing) throw new InstanceAdminError('assistant_config_missing', 503);
  const next = validateAssistantConfig(Object.fromEntries(assistantFields.map((field) => [field, patch[field] ?? existing[field]])));
  const [result] = await atomic(db, [
    statement(db, `UPDATE music_assistant_configs SET name = ?, description = ?, avatar_icon = ?, persona = ?,
      welcome_message = ?, system_rules = ?, provider = ?, model = ?, temperature = ?,
      revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = 'xiaoa' AND revision = ?
      AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    ...assistantFields.map((field) => next[field]), now, actor.account_id, expectedRevision, actor.account_id),
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'assistant.update', 'assistant', 'xiaoa', 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, now),
  ]);
  if (!changed(result)) throw new InstanceAdminError('revision_conflict', 409);
  return { ...next, revision: expectedRevision + 1 };
}
