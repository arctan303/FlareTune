import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_API_BASE_URL, resolveApiBase } from './apiBase.js';
import viteDevelopmentConfig from '../../vite.config.js';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('uses the configured base and removes one trailing slash', () => {
  assert.equal(resolveApiBase({ configuredBase: 'https://api.example.test/' }), 'https://api.example.test');
  assert.equal(resolveApiBase({ configuredBase: 'https://api.example.test/path//' }), 'https://api.example.test/path/');
  assert.equal(resolveApiBase({ configuredBase: ' http://localhost:8789/ ' }), 'http://localhost:8789');
});

test('uses the current production default when the configured base is absent', () => {
  assert.equal(DEFAULT_API_BASE_URL, '');
  assert.equal(resolveApiBase(), '');
  assert.equal(resolveApiBase({ configuredBase: '' }), '');
  assert.equal(resolveApiBase({ configuredBase: null }), '');
});

test('local frontend uses the same-origin Worker proxy without OAuth defaults', () => {
  const developmentEnv = readSource('../../../.env.development');
  const localWrangler = readSource('../../../server/wrangler.local.toml');
  const viteConfig = readSource('../../vite.config.js');
  const apiBase = developmentEnv.match(/^VITE_API_BASE_URL=(.+)$/m)?.[1]?.trim();

  assert.equal(apiBase, undefined, 'development API calls must use the same-origin Vite proxy');
  assert.match(viteConfig, /server:\s*\{[\s\S]*?host:\s*'127\.0\.0\.1',[\s\S]*?port:\s*3000,/);
  assert.equal(viteDevelopmentConfig.server.proxy['/api'].target, 'http://127.0.0.1:8789');
  assert.equal(viteDevelopmentConfig.server.proxy['/media'].target, 'http://127.0.0.1:8789');
  assert.doesNotMatch(localWrangler, /^OAUTH_ISSUER\s*=|^CLIENT_ID\s*=|^REDIRECT_URI\s*=/m);
  assert.doesNotMatch(localWrangler, /^CORS_ORIGINS\s*=|^MUSIC_WEB_ORIGIN\s*=/m);
});

test('production consumers use the single no-strategy API base contract', () => {
  const sources = [
    '../accountPlaylists.js',
    './localLyricsWorkspaceApi.js',
    '../hooks/useArtistPhotos.js',
    '../hooks/useRandomSongs.js',
    '../hooks/useMusicData.js',
    '../components/SearchView.jsx',
    '../components/AccountMenu.jsx',
    '../components/AssistantView.jsx',
    './songApi.js',
    '../resolveSongs.js',
  ].map(readSource);

  for (const source of sources) {
    assert.doesNotMatch(source, /fallbackBase|devServerMode|allowDevServerWithoutWindow|collapseConfiguredOriginOnLocalPage|configuredBaseMode/);
  }
});
