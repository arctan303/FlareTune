// Explicit test capabilities for existing isolated lyric-policy tests. Real
// authorization is exercised separately by handler tests with D1 sessions.
import { DEFAULT_LYRIC_AI_CONFIG } from '../../utils/lyricAiConfig.js';
import { loadLyricAiConfig } from '../../services/lyricAiConfig.js';
export function testLyricsAiDeps(deps = {}) {
  let policy;
  return { ...deps, getAIAssistantConfig: deps.getAIAssistantConfig || (async () => DEFAULT_LYRIC_AI_CONFIG),
    loadLyricAiConfig: async (...args) => { policy = await (deps.loadLyricAiConfig || loadLyricAiConfig)(...args); return policy; },
    createServiceLease: deps.createServiceLease || testLyricsAiLease,
    createGatewayClient: deps.createGatewayClient || (async ({ env, configuration }) => {
    if (configuration?.slot !== 'ai-model') throw new Error('TEST_MODEL_CONFIGURATION_REQUIRED');
    const assigned = await deps.resolveAiFeature?.({}, 'lyrics', env, policy);
    const model = assigned?.config || deps.lyricConfig || policy || DEFAULT_LYRIC_AI_CONFIG;
    const config = { ...model, generationOptions: { ...(model.temperature === undefined ? {} : { temperature: model.temperature }), ...model.generationOptions } };
    return { config, assertCurrent: deps.assertCurrent || (async () => {}), guardedDb: db => db || env.DB,
      ask: (messages, overrides, options) => {
        if (!deps.askAI) throw new Error('AI_MISSING_KEY');
        return deps.askAI(messages, { ...config, ...overrides }, assigned?.env || env, options);
      } };
  }) };
}
export const testLyricsContext = Object.freeze({ requireRoles: async () => {}, assertCurrent: async () => {} });
export const testLyricsAiLease = async () => ({ assertCurrent: async () => {}, guardedDb: db => db });
