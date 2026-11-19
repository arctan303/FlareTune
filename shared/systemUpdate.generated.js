// Generated from the actual host and compiled package selection. No instance credentials.
import { deliveryPluginManifests, compiledPluginSources } from './plugins/delivery.generated.js';
const plugins = Object.freeze(deliveryPluginManifests.map(manifest => Object.freeze({ id: manifest.id, version: manifest.version, manifest, source: compiledPluginSources[manifest.id] })));
export const systemUpdateRuntime = Object.freeze({ ...{
  "version": "1.3.0",
  "sourceDigest": "64ae28d9f7ed34ddddff5d933a5e7a9a4ae9ca8deeaa82599704928889acbb66",
  "hostApiVersion": 6
}, plugins });
