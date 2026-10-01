import { AI_REASONING_EFFORTS, AI_SOURCES, effectiveAiBaseUrl, legacyProtocol, sourceFromProvider } from '../../../shared/aiProtocols.js';

export function aiProfileDraft(profile) {
  const source = profile?.source || sourceFromProvider(profile?.provider) || 'deepseek';
  return { name: profile?.name || '', source,
    protocol: profile?.protocol || (profile ? legacyProtocol(profile.provider) : AI_SOURCES[source].protocol),
    model: profile?.model || '', baseUrl: profile?.baseUrl || '', apiKey: '', supportsImages: profile?.supportsImages === true,
    generationOptions: { ...profile?.generationOptions } };
}

export function changeAiSource(draft, source) {
  return { ...draft, source, protocol: AI_SOURCES[source].protocol,
    baseUrl: '', model: '', apiKey: '', supportsImages: false, generationOptions: {} };
}

export function changeAiProtocol(draft, protocol) {
  const { thinkingBudget, thinkingMode, ...options } = draft.generationOptions;
  if (!AI_REASONING_EFFORTS[protocol].includes(options.reasoningEffort)) delete options.reasoningEffort;
  return { ...draft, protocol, generationOptions: options };
}

export function aiProfileNeedsKey(profile, draft) {
  if (!profile || !profile.hasKey) return true;
  const source = profile.source || sourceFromProvider(profile.provider);
  return source !== draft.source || (profile.protocol || legacyProtocol(profile.provider)) !== draft.protocol
    || effectiveAiBaseUrl(source, profile.baseUrl, profile.protocol || legacyProtocol(profile.provider))
      !== effectiveAiBaseUrl(draft.source, draft.baseUrl, draft.protocol);
}

export function aiProfilePayload(draft) {
  const options = Object.fromEntries(Object.entries(draft.generationOptions)
    .filter(([, value]) => value !== '' && value !== undefined && value !== null)
    .map(([key, value]) => [key, ['reasoningEffort', 'thinkingMode'].includes(key) ? value : Number(value)]));
  return { ...draft, generationOptions: options };
}

export function aiProfileAdvanced(profile) {
  if (!profile) return false;
  const draft = aiProfileDraft(profile);
  return draft.source === 'custom' || Boolean(draft.baseUrl)
    || draft.protocol !== AI_SOURCES[draft.source].protocol || Object.keys(draft.generationOptions).length > 0;
}
