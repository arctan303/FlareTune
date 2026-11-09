// Compatibility for existing local commands. Wasm now belongs to the selected,
// hash-verified package; the host does not build a private YouTube copy.
import { preparePluginSeed } from './seed.mjs';
console.log(JSON.stringify(await preparePluginSeed()));
