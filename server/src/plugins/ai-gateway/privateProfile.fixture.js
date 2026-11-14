import { compiledPluginSources } from '../../../../shared/plugins/delivery.generated.js';

// Host-only tests exercise credential rotation inside the selected package.
// This is deliberately not an SDK/service export. Public callers get safe DTOs.
const digest = compiledPluginSources['ai-gateway'].sha256;
const implementation = await import(new URL(`../../../../shared/plugins/.delivery/ai-gateway/${digest}/server/_private/profiles.js`, import.meta.url));
export const resolveAiFeature = implementation.resolveAiFeature;
