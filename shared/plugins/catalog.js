import { validatePluginManifests } from './manifest.js';
import { deliveryPluginManifests } from './delivery.generated.js';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

// Only the reviewed, generated selection is compiled into this deployment.
export const compiledPluginManifests = freeze(validatePluginManifests(deliveryPluginManifests));
