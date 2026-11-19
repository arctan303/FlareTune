// Generated from the actual host and compiled package selection. No instance credentials.
import { deliveryPluginManifests, compiledPluginSources } from './plugins/delivery.generated.js';
const plugins = Object.freeze(deliveryPluginManifests.map(manifest => Object.freeze({ id: manifest.id, version: manifest.version, manifest, source: compiledPluginSources[manifest.id] })));
export const systemUpdateRuntime = Object.freeze({ ...{
  "version": "1.3.0",
  "sourceDigest": "0e6c97c0c49669d9752e2025a7b155ec5f318234612627a23749820bf7a2f322",
  "hostApiVersion": 6
}, plugins });
