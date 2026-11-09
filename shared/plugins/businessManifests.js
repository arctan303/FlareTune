// Compatibility metadata follows the current selection; this file owns no plugin definitions.
import { deliveryPluginManifests } from './delivery.generated.js';
export const businessPluginManifests = deliveryPluginManifests.filter(plugin =>
  ['ai-gateway', 'assistant', 'lyrics-workbench'].includes(plugin.id));
