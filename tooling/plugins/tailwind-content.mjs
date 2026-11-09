import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const fail = () => { throw new Error('PLUGIN_CSS_INVENTORY_INVALID'); };

// Hydration may cache more packages than the current selection. Only selected
// client/shared modules contribute utility styles; server/vendor code never does.
export function pluginTailwindContent(root = repositoryRoot) {
  const inventory = JSON.parse(readFileSync(resolve(root, 'tooling/plugins/delivery-source.generated.json'), 'utf8'));
  if (!inventory?.plugins || typeof inventory.plugins !== 'object' || Array.isArray(inventory.plugins)) fail();
  const files = new Set();
  for (const [id, definition] of Object.entries(inventory.plugins)) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || !Array.isArray(definition?.files)) fail();
    for (const path of definition.files) {
      if (typeof path !== 'string') fail();
      if (!path.startsWith('shared/plugins/.delivery/')) continue;
      if (!path.startsWith(`shared/plugins/.delivery/${id}/`) || /[^A-Za-z0-9_./-]/.test(path)
        || path.split('/').some(part => !part || part === '.' || part === '..')) fail();
      const suffix = path.slice(`shared/plugins/.delivery/${id}/`.length);
      if (!/^[a-f0-9]{64}\/(?:client|shared)\/.+\.(?:js|mjs|jsx)$/.test(suffix)) continue;
      files.add(resolve(root, path).replaceAll('\\', '/'));
    }
  }
  return [...files].sort();
}
