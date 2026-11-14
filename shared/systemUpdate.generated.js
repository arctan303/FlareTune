// Generated from the actual host and compiled package selection. No instance credentials.
import { deliveryPluginManifests, compiledPluginSources } from './plugins/delivery.generated.js';
const plugins = Object.freeze(deliveryPluginManifests.map(manifest => Object.freeze({ id: manifest.id, version: manifest.version, manifest, source: compiledPluginSources[manifest.id] })));
export const systemUpdateRuntime = Object.freeze({ ...{
  "version": "1.3.0",
  "sourceDigest": "f55dec9524690257ad1cc54b3c6d2d0dfbedefe6f944d4c10e07b5b784b86475",
  "hostApiVersion": 5
}, plugins });
