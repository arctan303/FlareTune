// Generated from the actual host and compiled package selection. No instance credentials.
import { deliveryPluginManifests, compiledPluginSources } from './plugins/delivery.generated.js';
const plugins = Object.freeze(deliveryPluginManifests.map(manifest => Object.freeze({ id: manifest.id, version: manifest.version, manifest, source: compiledPluginSources[manifest.id] })));
export const systemUpdateRuntime = Object.freeze({ ...{
  "version": "1.3.0",
  "sourceDigest": "8bbc9e25d8137fe3dd0f4f387de748a5a77501c16ae6bc24bb135f7634a74be9",
  "hostApiVersion": 5
}, plugins });
