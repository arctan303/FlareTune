import { resolveInstanceState } from './state.js';
import { initializeEmptyDatabase, BootstrapError } from './bootstrap.js';
import { consumeSetupVerificationAttempt, issuePurposeProof, issueSetupProof,
  verifyPurposeProof, verifySetupProof } from './setupProof.js';
import { CURRENT_SCHEMA_VERSION } from './schemaManifest.js';
import { runKnownDatabaseUpgrade, DatabaseUpgradeError } from './upgradeDatabase.js';
import { decideApiAccess } from './accessPolicy.js';
import { isTrustedMutationRequest, readBoundedJson, RequestBodyError } from './httpSecurity.js';
import { InstanceAdminError } from '../instanceAdmin/common.js';
import { createAccount, listAccounts, resetAccountPassword, updateAccount } from '../instanceAdmin/accounts.js';
import { getAdminSettings, updateAdminSetting, updateAssistantConfig } from '../instanceAdmin/settings.js';
import { listAiProfiles, listAiModels, createAiProfile, updateAiProfile, deleteAiProfile,
  assignAiProfile } from '../instanceAdmin/aiProfiles.js';
import { listAiProviders, createAiProvider, updateAiProvider, deleteAiProvider, listAiProviderModels,
  saveAiFeatureModel } from '../instanceAdmin/aiProviders.js';
import { validateSetting } from '../instanceAdmin/settings.js';
import { handleLocalMusicReadRoute } from '../routes/localMusicRead.js';
import { handleLocalAccountMusicRoute } from '../routes/localAccountMusic.js';
import { handleLocalMusicDiscoveryRoute } from '../routes/localMusicDiscovery.js';
import { handleLocalAlbumReadRoute } from '../routes/localAlbumRead.js';
import { handleLocalAssistantRoute } from '../routes/localAssistant.js';
import { handleLocalMetadataReadRoute } from '../routes/localMetadataRead.js';
import { handleLocalLyricsManageRoute } from '../routes/localLyricsManage.js';
import { handleLocalCatalogAdminRoute } from '../routes/localCatalogAdmin.js';
import { handleLocalCatalogMediaRoute } from '../routes/localCatalogMedia.js';
import { handleLocalIngestDevicesRoute } from '../routes/localIngestDevices.js';
import { consumeAuthAttempt, RateLimitError } from '../auth/local/rateLimit.js';
import { getOwnUiLanguage, updateOwnDisplayName, updateOwnUiLanguage } from '../auth/local/profile.js';
import { handleUserImages } from '../routes/userImages.js';
import { handleGoogleRequest, googleSchemaReady } from '../auth/google.js';
import { getOwnImageSlot, userImagesReady } from '../services/userImages.js';
import { ownStatus as subsonicStatus, setEnabled as setSubsonicEnabled } from '../subsonic/credentials.js';
import {
  AuthError,
  claimInstance,
  clearSessionCookie,
  changePassword,
  getSessionAfterReadyCheck,
  login,
  logout,
  sessionCookie,
  tokenFromCookie,
  verifyCsrfToken,
} from '../auth/local/index.js';

export const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  },
});

const authFailure = (error) => {
  if (error instanceof AuthError) return json({ error: error.code }, error.status);
  if (error instanceof InstanceAdminError) return json({ error: error.code }, error.status);
  if (error instanceof RateLimitError) return json({ error: error.code }, error.status);
  if (error instanceof RequestBodyError) return json({ error: 'invalid_input' }, 400);
  if (error instanceof BootstrapError) return json({ error: error.code }, error.status);
  if (error instanceof DatabaseUpgradeError) return json({ error: error.code }, error.status);
  return json({ error: 'service_unavailable' }, 503);
};

async function configuredCrossOrigin(db, origin, instanceState) {
  if (instanceState !== 'ready' || !origin) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) return null;
    const row = await db.prepare("SELECT value_json FROM instance_settings WHERE key = 'cors.allowed_origins'").first();
    const allowed = validateSetting('cors.allowed_origins', JSON.parse(row?.value_json ?? '[]'));
    return allowed.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}

function attachCors(response, origin) {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

export async function handleApi(request, env, path, ctx) {
  if (path === '/api/auth/recovery') return json({ error: 'not_found' }, 404);
  const cacheSchema = request.method === 'GET'
    && !['/api/health', '/api/instance/status'].includes(path)
    && !path.startsWith('/api/admin/') && !path.startsWith('/api/manage/')
    && !path.startsWith('/api/instance/');
  const instance = await resolveInstanceState(env?.DB, Date.now(), { cacheSchema });
  const origin = request.headers.get('Origin');
  const sameOrigin = new URL(request.url).origin;
  const crossOrigin = origin && origin !== sameOrigin
    ? await configuredCrossOrigin(env?.DB, origin, instance.state) : null;
  const response = await handleApiInternal(request, env, path, instance, crossOrigin, ctx);
  return attachCors(response, crossOrigin);
}

async function handleApiInternal(request, env, path, instance, crossOrigin, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'Cache-Control': 'no-store',
    ...(crossOrigin ? {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With, X-CSRF-Token, X-FlareTune-Expected-Account, X-FlareTune-Media-Size',
      'Access-Control-Max-Age': '600',
    } : {}),
  } });
  if (path === '/api/instance/status' && request.method === 'GET') {
    return json({ state: instance.state, schemaVersion: instance.schemaVersion,
      targetVersion: CURRENT_SCHEMA_VERSION });
  }
  if (path === '/api/health' && request.method === 'GET') {
    return json({ ok: instance.state !== 'recovery_required', state: instance.state },
      instance.state === 'recovery_required' ? 503 : 200);
  }

  let token = null;
  let session = null;
  if (instance.state === 'ready') {
    token = tokenFromCookie(request.headers.get('Cookie'));
    try {
      if (token) session = await getSessionAfterReadyCheck({ db: env.DB, token });
    } catch {
      return json({ error: 'service_unavailable' }, 503);
    }
  }
  if (path === '/api/auth/session' && request.method === 'GET') {
    return json(session ? {
      authenticated: true,
      mustChangePassword: session.mode === 'must_change_password',
      user: { ...session.account, uiLanguage: await getOwnUiLanguage(env.DB, session.account.accountId),
        ...(session.mode === 'normal' ? { avatar: await getOwnImageSlot(env.DB, session.account.accountId, 'avatar', 'avatar') } : {}) },
      csrfToken: session.csrfToken,
    } : { authenticated: false, mustChangePassword: false });
  }

  const access = decideApiAccess({ path, method: request.method, instanceState: instance.state, session });
  if (!access.allowed) {
    if (instance.state !== 'ready') return json({ error: instance.state }, 503);
    if (!session && access.category !== 'setup') {
      return json({ error: 'authentication_required' }, 401);
    }
    return json({ error: 'forbidden' }, 403);
  }

  if (request.method !== 'GET' && !isTrustedMutationRequest(request, crossOrigin ? [crossOrigin] : [])) {
    return json({ error: 'csrf_rejected' }, 403);
  }
  if (session && request.method !== 'GET' && !['login', 'setup', 'maintenance_verify', 'maintenance_upgrade'].includes(access.category)
    && !await verifyCsrfToken(token, request.headers.get('X-CSRF-Token'))) {
    return json({ error: 'csrf_rejected' }, 403);
  }
  const expectedAccountId = request.headers.get('X-FlareTune-Expected-Account');
  if (session && expectedAccountId && expectedAccountId !== session.account?.accountId) {
    return json({ error: 'account_changed' }, 409);
  }

  try {
    const googleResponse = await handleGoogleRequest(request, env, path, session, json);
    if (googleResponse) return googleResponse;
    if (access.category === 'verify-setup') {
      const body = await readBoundedJson(request);
      const limit = consumeSetupVerificationAttempt(request);
      if (!limit.allowed) return json({ error: 'rate_limited' }, 429,
        { 'Retry-After': String(limit.retryAfterSeconds) });
      const proof = await issueSetupProof(env.SETUP_SECRET, body.setupSecret,
        new URL(request.url).origin);
      if (!proof) return json({ error: 'invalid_setup' }, 403);
      return json({ proof, expiresInSeconds: 600 });
    }
    if (access.category === 'setup') {
      const body = await readBoundedJson(request);
      if (!await verifySetupProof(env.SETUP_SECRET, body.proof, new URL(request.url).origin)) {
        return json({ error: 'invalid_setup' }, 403);
      }
      await initializeEmptyDatabase(env.DB);
      const limit = await consumeAuthAttempt({ db: env.DB, request, kind: 'setup' });
      if (!limit.allowed) return json({ error: 'rate_limited' }, 429,
        { 'Retry-After': String(limit.retryAfterSeconds) });
      await claimInstance({ db: env.DB, setupSecret: env.SETUP_SECRET,
        suppliedSecret: env.SETUP_SECRET, username: body.username, password: body.password });
      return json({ ok: true }, 201);
    }
    if (access.category === 'maintenance_verify') {
      const body = await readBoundedJson(request);
      const limit = consumeSetupVerificationAttempt(request);
      if (!limit.allowed) return json({ error: 'rate_limited' }, 429,
        { 'Retry-After': String(limit.retryAfterSeconds) });
      const proof = await issuePurposeProof(env.SETUP_SECRET, body.setupSecret,
        new URL(request.url).origin, 'maintenance');
      if (!proof) return json({ error: 'invalid_setup' }, 403);
      return json({ proof, expiresInSeconds: 600 });
    }
    if (access.category === 'maintenance_upgrade') {
      const body = await readBoundedJson(request);
      if (!await verifyPurposeProof(env.SETUP_SECRET, body.proof,
        new URL(request.url).origin, 'maintenance')) return json({ error: 'invalid_setup' }, 403);
      return json(await runKnownDatabaseUpgrade(env.DB, { allowDestructive: body.backupConfirmed === true }));
    }
    if (access.category === 'admin_migration') {
      if (request.method === 'GET') return json({ schemaVersion: instance.schemaVersion,
        targetVersion: CURRENT_SCHEMA_VERSION, state: instance.state,
        supplementalPending: !await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_profile_protocols'").first()
          || !await userImagesReady(env.DB)
          || !await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_feature_models'").first()
          || !await googleSchemaReady(env.DB) });
      await readBoundedJson(request);
      let result;
      // Finish a compatible migration while this authenticated request still has
      // access. If it cannot finish here, the instance stays in maintenance and
      // subsequent requests require the initialization secret.
      for (let step = 0; step < 20; step += 1) {
        result = await runKnownDatabaseUpgrade(env.DB);
        if (result.status !== 'in_progress') break;
      }
      return json(result);
    }
    if (access.category === 'login') {
      const body = await readBoundedJson(request);
      const limit = await consumeAuthAttempt({ db: env.DB, request, kind: 'login', username: body.username });
      if (!limit.allowed) return json({ error: 'rate_limited' }, 429,
        { 'Retry-After': String(limit.retryAfterSeconds) });
      const result = await login({ db: env.DB, username: body.username, password: body.password });
      return json({ authenticated: true, mustChangePassword: result.mode === 'must_change_password',
        user: result.account, csrfToken: result.csrfToken }, 200,
      { 'Set-Cookie': sessionCookie(result.token, { mode: result.mode, expiresAt: result.expiresAt,
        sameSite: crossOrigin ? 'None' : 'Strict' }) });
    }
    if (access.category === 'logout') {
      if (token) await logout({ db: env.DB, token });
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    }
    if (access.category === 'change-password') {
      const body = await readBoundedJson(request);
      await changePassword({ db: env.DB, session, currentPassword: body.currentPassword,
        newPassword: body.newPassword });
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    }
    const actorAccountId = session?.account?.accountId;
    const imageResponse = await handleUserImages(request, new URL(request.url), env.DB, env.MEDIA_BUCKET, session);
    if (imageResponse) return imageResponse;
    if (path === '/api/account/subsonic' && request.method === 'GET') {
      return json(await subsonicStatus(env.DB, actorAccountId, env));
    }
    if (path === '/api/account/subsonic' && request.method === 'PUT') {
      const body = await readBoundedJson(request);
      if (body.enabled === true) {
        const limit = await consumeAuthAttempt({ db: env.DB, request, kind: 'login', username: session.account.username });
        if (!limit.allowed) return json({ error: 'rate_limited' }, 429);
      }
      return json(await setSubsonicEnabled(env.DB, session, body, env));
    }
    if (path === '/api/account/profile' && request.method === 'PATCH') {
      const body = await readBoundedJson(request);
      if (!body || Object.keys(body).some((key) => key !== 'displayName')) {
        return json({ error: 'invalid_input' }, 400);
      }
      return json({ user: await updateOwnDisplayName(env.DB, actorAccountId, body.displayName) });
    }
    if (path === '/api/account/ui-language' && request.method === 'PATCH') {
      const body = await readBoundedJson(request);
      if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'uiLanguage')) {
        return json({ error: 'invalid_input' }, 400);
      }
      return json(await updateOwnUiLanguage(env.DB, actorAccountId, body.uiLanguage));
    }
    if (path === '/api/admin/accounts' && request.method === 'GET') {
      return json(await listAccounts({ db: env.DB, actorAccountId }));
    }
    if (path === '/api/admin/accounts' && request.method === 'POST') {
      const body = await readBoundedJson(request);
      return json(await createAccount({ db: env.DB, actorAccountId, username: body.username,
        displayName: body.displayName, role: body.role, temporaryPassword: body.temporaryPassword }), 201);
    }
    const accountAction = path.match(/^\/api\/admin\/accounts\/([A-Za-z0-9_-]{1,128})(?:\/(reset-password))?$/);
    if (accountAction && request.method === 'PATCH' && !accountAction[2]) {
      const body = await readBoundedJson(request);
      return json(await updateAccount({ db: env.DB, actorAccountId, accountId: accountAction[1],
        role: body.role, status: body.status, displayName: body.displayName,
        expectedUpdatedAt: body.expectedUpdatedAt }));
    }
    if (accountAction && request.method === 'POST' && accountAction[2] === 'reset-password') {
      const body = await readBoundedJson(request);
      return json(await resetAccountPassword({ db: env.DB, actorAccountId,
        accountId: accountAction[1], temporaryPassword: body.temporaryPassword }));
    }
    if (path === '/api/admin/settings' && request.method === 'GET') {
      return json(await getAdminSettings(env.DB, actorAccountId,
        { aiApiKeyConfigured: Boolean(env.OPENAI_API_KEY || env.GEMINI_API_KEY || env.DEEPSEEK_API_KEY) }));
    }
    if (path === '/api/admin/ai/providers' && request.method === 'GET') {
      return json(await listAiProviders(env.DB, actorAccountId, env));
    }
    if (path === '/api/admin/ai/providers' && request.method === 'POST') {
      return json(await createAiProvider(env.DB, actorAccountId, await readBoundedJson(request), env), 201);
    }
    if (path === '/api/admin/ai/provider-models' && request.method === 'POST') {
      return json(await listAiProviderModels(env.DB, actorAccountId, await readBoundedJson(request), env));
    }
    if (path === '/api/admin/ai/feature-models' && request.method === 'PUT') {
      return json(await saveAiFeatureModel(env.DB, actorAccountId, await readBoundedJson(request), env));
    }
    const aiProviderAction = path.match(/^\/api\/admin\/ai\/providers\/([0-9a-f-]{36})$/);
    if (aiProviderAction && ['PUT', 'DELETE'].includes(request.method)) {
      const body = await readBoundedJson(request);
      return json(request.method === 'PUT'
        ? await updateAiProvider(env.DB, actorAccountId, aiProviderAction[1], body.provider, body.expectedRevision, env)
        : await deleteAiProvider(env.DB, actorAccountId, aiProviderAction[1], body.expectedRevision));
    }
    if (path === '/api/admin/ai/models' && request.method === 'POST') {
      const body = await readBoundedJson(request);
      return json(await listAiModels(env.DB, actorAccountId, body, env));
    }
    if (path === '/api/admin/ai/profiles' && request.method === 'GET') {
      return json(await listAiProfiles(env.DB, actorAccountId, env));
    }
    if (path === '/api/admin/ai/profiles' && request.method === 'POST') {
      const body = await readBoundedJson(request);
      return json(await createAiProfile(env.DB, actorAccountId, body, env), 201);
    }
    const aiProfileAction = path.match(/^\/api\/admin\/ai\/profiles\/([0-9a-f-]{36})$/);
    if (aiProfileAction && request.method === 'PUT') {
      const body = await readBoundedJson(request);
      return json(await updateAiProfile(env.DB, actorAccountId, aiProfileAction[1],
        body.profile, body.expectedRevision, env));
    }
    if (aiProfileAction && request.method === 'DELETE') {
      const body = await readBoundedJson(request);
      return json(await deleteAiProfile(env.DB, actorAccountId, aiProfileAction[1],
        body.expectedRevision));
    }
    if (path === '/api/admin/ai/assignments' && request.method === 'PUT') {
      const body = await readBoundedJson(request);
      return json(await assignAiProfile(env.DB, actorAccountId, body.feature, body.profileId,
        body.expectedRevision));
    }
    if (path === '/api/admin/settings' && request.method === 'PUT') {
      const body = await readBoundedJson(request);
      return json(await updateAdminSetting(env.DB, actorAccountId,
        body.key, body.value, body.expectedRevision));
    }
    if (path === '/api/admin/assistant' && request.method === 'PUT') {
      const body = await readBoundedJson(request);
      return json(await updateAssistantConfig(env.DB, actorAccountId,
        body.patch, body.expectedRevision));
    }
    const musicRead = await handleLocalMusicReadRoute(request, new URL(request.url), env.DB,
      {}, actorAccountId);
    if (musicRead) return musicRead;
    const albumRead = await handleLocalAlbumReadRoute(request, new URL(request.url), env.DB,
      {}, actorAccountId);
    if (albumRead) return albumRead;
    const musicDiscovery = await handleLocalMusicDiscoveryRoute(request, new URL(request.url), env.DB,
      {}, actorAccountId);
    if (musicDiscovery) return musicDiscovery;
    const accountMusic = await handleLocalAccountMusicRoute(request, new URL(request.url), env.DB,
      {}, session);
    if (accountMusic) return accountMusic;
    const assistant = await handleLocalAssistantRoute(request, new URL(request.url), env.DB,
      {}, session, env);
    if (assistant) return assistant;
    const metadata = await handleLocalMetadataReadRoute(request, new URL(request.url), env.DB,
      {}, actorAccountId, env, { ctx });
    if (metadata) return metadata;
    const lyricsManage = await handleLocalLyricsManageRoute(request, new URL(request.url), env.DB,
      {}, session, env, { ctx });
    if (lyricsManage) return lyricsManage;
    const catalogMedia = await handleLocalCatalogMediaRoute(request, new URL(request.url), env.DB,
      {}, session, env);
    if (catalogMedia) return catalogMedia;
    const ingestDevices = await handleLocalIngestDevicesRoute(request, new URL(request.url), env.DB,
      {}, session, env);
    if (ingestDevices) return ingestDevices;
    const catalogAdmin = await handleLocalCatalogAdminRoute(request, new URL(request.url), env.DB,
      {}, session, env);
    if (catalogAdmin) return catalogAdmin;
    // Business and administrative APIs are opened only when their replacement
    // implementations have explicit route/role tests. Never fall through to OAuth.
    return json({ error: 'phase_not_ready' }, 503);
  } catch (error) {
    return authFailure(error);
  }
}
