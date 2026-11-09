// Explicit test capabilities for existing isolated lyric-policy tests. Real
// authorization is exercised separately by handler tests with D1 sessions.
import { DEFAULT_LYRIC_AI_CONFIG } from '../../utils/lyricAiConfig.js';
export function testLyricsAiDeps(deps = {}) {
  return { ...deps, getAIAssistantConfig: deps.getAIAssistantConfig || (async () => DEFAULT_LYRIC_AI_CONFIG),
    createServiceLease: deps.createServiceLease || testLyricsAiLease,
    createGatewayClient: deps.createGatewayClient || (async ({ env, legacyConfig }) => {
    const assigned = await deps.resolveAiFeature?.({}, 'lyrics', env, legacyConfig);
    const config = assigned?.config || legacyConfig;
    return { config, assertCurrent: deps.assertCurrent || (async () => {}), guardedDb: db => db,
      ask: (messages, overrides, options) => {
        if (!deps.askAI) throw new Error('AI_MISSING_KEY');
        return deps.askAI(messages, { ...config, ...overrides }, assigned?.env || env, options);
      } };
  }) };
}
export const testLyricsContext = Object.freeze({ requireRoles: async () => {}, assertCurrent: async () => {} });
export const testLyricsAiLease = async () => ({ assertCurrent: async () => {}, guardedDb: db => db });
