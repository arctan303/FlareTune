// Public import identities are exact, side-specific capabilities. This map is
// part of the immutable host; plugin packages cannot supply additional targets.
export const pluginSdkImports = Object.freeze({
  "@flaretune/plugin-sdk": Object.freeze({"target":"client/src/plugins/sdk.js","side":"client"}),
  "@flaretune/plugin-sdk/pure": Object.freeze({"target":"client/src/plugins/sdk-pure.js","side":"client"}),
  "@flaretune/plugin-sdk/client/i18n": Object.freeze({"target":"client/src/i18n/index.js","side":"client"}),
  "@flaretune/plugin-sdk/client/settings-section": Object.freeze({"target":"client/src/components/SettingsSection.jsx","side":"client"}),
  "@flaretune/plugin-sdk/client/settings-dialog": Object.freeze({"target":"client/src/components/SettingsEditDialog.jsx","side":"client"}),
  "@flaretune/plugin-sdk/client/settings-skeleton": Object.freeze({"target":"client/src/components/SettingsSkeleton.jsx","side":"client"}),
  "@flaretune/plugin-sdk/client/settings-controls": Object.freeze({"target":"client/src/components/SettingsControls.jsx","side":"client"}),
  "@flaretune/plugin-sdk/client/select-control": Object.freeze({"target":"client/src/components/SelectControl.jsx","side":"client"}),
  "@flaretune/plugin-sdk/client/player-actions": Object.freeze({"target":"client/src/plugins/playerActionPrimitives.js","side":"client"}),
  "@flaretune/plugin-sdk/client/typewriter": Object.freeze({"target":"client/src/aiResponseTypewriter.js","side":"client"}),
  "@flaretune/plugin-sdk/server/admin-common": Object.freeze({"target":"server/src/plugins/sdk/admin-common.js","side":"server"}),
  "@flaretune/plugin-sdk/server/service-leases": Object.freeze({"target":"server/src/plugins/sdk/service-leases.js","side":"server"}),
  "@flaretune/plugin-sdk/server/service-config": Object.freeze({"target":"server/src/plugins/sdk/service-config.js","side":"server"}),
  "@flaretune/plugin-sdk/server/plugin-common": Object.freeze({"target":"server/src/plugins/sdk/plugin-common.js","side":"server"}),
  "@flaretune/plugin-sdk/server/subsonic-principal": Object.freeze({"target":"server/src/plugins/sdk/subsonic-principal.js","side":"server"}),
  "@flaretune/plugin-sdk/server/http-security": Object.freeze({"target":"server/src/plugins/sdk/http-security.js","side":"server"}),
  "@flaretune/plugin-sdk/server/settings": Object.freeze({"target":"server/src/plugins/sdk/settings.js","side":"server"}),
  "@flaretune/plugin-sdk/server/plugin-context": Object.freeze({"target":"server/src/plugins/sdk/plugin-context.js","side":"server"}),
  "@flaretune/plugin-sdk/server/plugin-registry": Object.freeze({"target":"server/src/plugins/sdk/plugin-registry.js","side":"server"}),
  "@flaretune/plugin-sdk/server/auth": Object.freeze({"target":"server/src/plugins/sdk/auth.js","side":"server"}),
  "@flaretune/plugin-sdk/server/account-music": Object.freeze({"target":"server/src/plugins/sdk/account-music.js","side":"server"}),
  "@flaretune/plugin-sdk/server/image-resources": Object.freeze({"target":"server/src/plugins/sdk/image-resources.js","side":"server"}),
  "@flaretune/plugin-sdk/server/song-dto": Object.freeze({"target":"server/src/plugins/sdk/song-dto.js","side":"server"}),
  "@flaretune/plugin-sdk/server/account-read-model": Object.freeze({"target":"server/src/plugins/sdk/account-read-model.js","side":"server"}),
  "@flaretune/plugin-sdk/server/song-language": Object.freeze({"target":"server/src/plugins/sdk/song-language.js","side":"server"}),
  "@flaretune/plugin-sdk/server/japanese-romanization": Object.freeze({"target":"server/src/plugins/sdk/japanese-romanization.js","side":"server"}),
  "@flaretune/plugin-sdk/server/song-search-order": Object.freeze({"target":"server/src/plugins/sdk/song-search-order.js","side":"server"}),
  "@flaretune/plugin-sdk/server/lyric-assets": Object.freeze({"target":"server/src/plugins/sdk/lyric-assets.js","side":"server"}),
  "@flaretune/plugin-sdk/server/lyric-workflow": Object.freeze({"target":"server/src/plugins/sdk/lyric-workflow.js","side":"server"}),
  "@flaretune/plugin-sdk/server/lyric-document": Object.freeze({"target":"server/src/plugins/sdk/lyric-document.js","side":"server"}),
  "@flaretune/plugin-sdk/server/lyric-source": Object.freeze({"target":"server/src/plugins/sdk/lyric-source.js","side":"server"}),
  "@flaretune/plugin-sdk/server/lyric-parsing": Object.freeze({"target":"server/src/plugins/sdk/lyric-parsing.js","side":"server"}),
  "@flaretune/plugin-sdk/server/lyric-sources": Object.freeze({"target":"server/src/plugins/sdk/lyric-sources.js","side":"server"}),
  "@flaretune/plugin-sdk/server/lyric-resolution": Object.freeze({"target":"server/src/plugins/sdk/lyric-resolution.js","side":"server"}),
  "@flaretune/plugin-sdk/server/lyric-source-settings": Object.freeze({"target":"server/src/plugins/sdk/lyric-source-settings.js","side":"server"}),
  "@flaretune/plugin-sdk/server/lyric-candidates": Object.freeze({"target":"server/src/plugins/sdk/lyric-candidates.js","side":"server"}),
  "@flaretune/plugin-sdk/server/playback-lyrics": Object.freeze({"target":"server/src/plugins/sdk/playback-lyrics.js","side":"server"}),
  "@flaretune/plugin-sdk/server/lyric-source-contract": Object.freeze({"target":"server/src/plugins/sdk/lyric-source-contract.js","side":"server"}),
  "@flaretune/plugin-sdk/server/song-projection": Object.freeze({"target":"server/src/plugins/sdk/song-projection.js","side":"server"}),
  "@flaretune/plugin-sdk/server/request-task": Object.freeze({"target":"server/src/plugins/sdk/request-task.js","side":"server"}),
  "@flaretune/plugin-sdk/server/music-catalog": Object.freeze({"target":"server/src/plugins/sdk/music-catalog.js","side":"server"}),
  "@flaretune/plugin-sdk/server/album-catalog": Object.freeze({"target":"server/src/plugins/sdk/album-catalog.js","side":"server"}),
  "@flaretune/plugin-sdk/server/catalog-discovery": Object.freeze({"target":"server/src/plugins/sdk/catalog-discovery.js","side":"server"}),
  "@flaretune/plugin-sdk/server/external-music-references": Object.freeze({"target":"server/src/plugins/sdk/external-music-references.js","side":"server"}),
  "@flaretune/plugin-sdk/server/instance-state": Object.freeze({"target":"server/src/plugins/sdk/instance-state.js","side":"server"}),
  "@flaretune/plugin-sdk/server/credential-format": Object.freeze({"target":"server/src/plugins/sdk/credential-format.js","side":"server"}),
  "@flaretune/plugin-sdk/server/media-objects": Object.freeze({"target":"server/src/plugins/sdk/media-objects.js","side":"server"}),
  "@flaretune/plugin-sdk/server/romanized-search": Object.freeze({"target":"server/src/plugins/sdk/romanized-search.js","side":"server"}),
  "@flaretune/plugin-sdk/server/invocation-database": Object.freeze({"target":"server/src/plugins/sdk/invocation-database.js","side":"server"}),
  "@flaretune/plugin-sdk/server/store-authority": Object.freeze({"target":"server/src/plugins/sdk/store-authority.js","side":"server"}),
});

export function pluginModuleSide(path) {
  return ['client','server','shared'].find(side=>path.startsWith(side+'/')) || null;
}

export function allowsPluginImport(from, target) {
  return from === 'shared' ? target === 'shared' : target === from || target === 'shared';
}

export function declaredPluginService(specifier, manifest) {
  const match=/^@flaretune\/plugin-service\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/((?:client|server|shared)\/[A-Za-z0-9_./-]+\.(?:js|mjs|jsx))$/.exec(specifier);
  if(!match || match[1]===manifest?.id || match[2].split('/').some(part=>!part||part==='.'||part==='..'))return null;
  if(!Object.hasOwn(manifest?.dependencies||{},match[1])&&!Object.hasOwn(manifest?.optionalDependencies||{},match[1]))return null;
  return { providerId:match[1], publicKey:match[2], side:pluginModuleSide(match[2]) };
}
