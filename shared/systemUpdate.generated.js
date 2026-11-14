// Generated from the actual host and compiled package selection. No instance credentials.
import { deliveryPluginManifests, compiledPluginSources } from './plugins/delivery.generated.js';
const plugins = Object.freeze(deliveryPluginManifests.map(manifest => Object.freeze({ id: manifest.id, version: manifest.version, manifest, source: compiledPluginSources[manifest.id] })));
export const systemUpdateRuntime = Object.freeze({ ...{
  "version": "1.3.0",
  "sourceDigest": "1739ab44e28b38e68770e494cc59b5fb4cdfaf52a1e585e4325825d012507f0b",
  "hostApiVersion": 5
}, plugins });
