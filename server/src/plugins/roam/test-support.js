import { fixture } from '../../subsonic/test-support.js';
import { createPluginRegistry } from '../registry.js';
import { compiledPluginManifests } from '../../../../shared/plugins/catalog.js';

export const BUILD_DIGEST = 'b'.repeat(64);
export const SAMPLE_BODY = { strategy: 'recent', recentSongIds: [], queuedSongIds: [], limit: 2 };
export const SAMPLE_PATHS = ['/api/account/plugins/roam/sample', '/api/songs/roam'];

export async function roamFixture(t, { roles = ['admin', 'member'] } = {}) {
  const f = await fixture();
  t.after(() => f.close());
  const manifest = { ...compiledPluginManifests.find(row => row.id === 'roam'),
    capabilityRoles: roles, pages: [], entries: [] };
  const registry = createPluginRegistry({ manifests: [manifest], builds: [{ id: 'roam', sourceDigest: BUILD_DIGEST }], deployment: null });
  const install = async (installed = true) => registry.setInstalled(f.env, f.signed.session, 'roam', {
    installed, revision: (await registry.readInstallation(f.env, 'roam')).revision,
  });
  return { ...f, registry, install };
}
