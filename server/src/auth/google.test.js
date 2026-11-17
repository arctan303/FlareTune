import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, PASSWORD } from '../subsonic/test-support.js';
import { handleGoogleRequest, verifyGoogleIdToken } from './google.js';
import { json } from '../instance/httpRouter.js';
import { tokenDigest } from './local/crypto.js';
import { getSessionAfterReadyCheck, tokenFromCookie } from './local/index.js';
import { runKnownDatabaseUpgrade } from '../instance/upgradeDatabase.js';

const clientId = 'fixture.apps.googleusercontent.com';
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign','verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'fixture', alg:'RS256', use:'sig' };
const b64 = value => Buffer.from(value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? value
  : typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function signedToken(nonce, overrides = {}, header = {}) {
  const now = Math.floor(Date.now()/1000);
  const data = b64({ alg:'RS256', kid:'fixture', ...header }) + '.' + b64({ iss:'https://accounts.google.com',
    aud:clientId, sub:'google-owner', email:'owner@gmail.com', email_verified:true, iat:now, exp:now+600, nonce, ...overrides });
  return data + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data))).toString('base64url');
}
async function configure(f, patch = {}, auth) {
  const current = await (await f.api('admin/google','GET',undefined,auth)).json();
  const res = await f.api('admin/google','PUT',{ enabled:true,clientId,clientSecret:'fixture-secret-only',callbackOrigin:'https://test.example',revision:current.revision,...patch },auth);
  assert.equal(res.status,200,await res.clone().text()); return res.json();
}
async function begin(f, purpose = 'bind', auth, currentPassword = PASSWORD) {
  const res = await f.api(purpose === 'bind' ? 'account/google/bind' : 'auth/google/start','POST',{currentPassword},auth);
  assert.equal(res.status,200,await res.clone().text());
  const url = new URL((await res.json()).url);
  return { url, cookie:res.headers.get('Set-Cookie').split(';')[0] };
}
async function finish(f, tx, { overrides, error, cookie = tx.cookie, mutate, header } = {}) {
  const nonce = tx.url.searchParams.get('nonce');
  const token = await signedToken(nonce,overrides,header);
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/token')) {
      assert.equal(options.body.get('client_secret'),'fixture-secret-only');
      const record = f.sqlite.prepare('SELECT verifier FROM google_login_transactions WHERE nonce=?').get(nonce);
      assert.equal(options.body.get('code_verifier'),record.verifier);
      assert.equal(tx.url.searchParams.get('code_challenge'), b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(record.verifier))));
      mutate?.(); return Response.json({id_token:token});
    }
    assert.equal(url,'https://www.googleapis.com/oauth2/v3/certs');
    return Response.json({keys:[jwk]});
  };
  const params = new URLSearchParams({state:tx.url.searchParams.get('state'),...(error ? {error} : {code:'fake-code'})});
  return handleGoogleRequest(new Request('https://test.example/auth/google/callback?'+params,{headers:{Cookie:cookie}}),f.env,
    '/auth/google/callback',null,json,fetchImpl);
}

test('Google binding then login preserves account, validates PKCE, and consumes state once',async()=>{
  const f=await fixture(); try {
    assert.deepEqual(await (await f.api('auth/google/status')).json(),{enabled:false});
    await configure(f);
    const saved=f.sqlite.prepare('SELECT * FROM google_login_config').get();
    assert.ok(!saved.encrypted_secret.includes('fixture-secret-only'));
    const admin=await (await f.api('admin/google')).json(); assert.ok(!JSON.stringify(admin).includes(saved.encrypted_secret));
    const tx=await begin(f); assert.equal((await finish(f,tx)).headers.get('Location'),'/settings/personal?google=bound');
    assert.equal((await finish(f,tx)).headers.get('Location'),'/?google=failed');
    assert.equal((await (await f.api('account/google')).json()).email,'owner@gmail.com');
    const loginTx=await begin(f,'login');
    const response=await finish(f,loginTx); assert.equal(response.headers.get('Location'),'/');
    const cookies=response.headers.getSetCookie();
    assert.ok(cookies.some(c=>c.includes('__Host-ft_google_transaction=;')));
    const sessionCookie=cookies.find(c=>c.startsWith('__Host-ft_session=')); assert.ok(sessionCookie);
    const session=await getSessionAfterReadyCheck({db:f.db,token:tokenFromCookie(sessionCookie.split(';')[0])});
    assert.equal(session.account.accountId,f.owner); assert.equal(session.account.role,'admin');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM accounts').get().n,2);
    assert.equal((await finish(f,loginTx)).headers.get('Location'),'/?google=failed');
  } finally {f.close();}
});

test('wrong browser, expired state, cancellation and configuration changes reject callback',async()=>{
  const f=await fixture(); try {
    await configure(f); const tx=await begin(f);
    assert.equal((await finish(f,tx,{cookie:''})).headers.get('Location'),'/?google=failed');
    assert.equal((await finish(f,tx,{error:'access_denied'})).headers.get('Location'),'/settings/personal?google=cancelled');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM account_google_bindings').get().n,0);
    const expired=await begin(f); f.sqlite.exec('UPDATE google_login_transactions SET expires_at=1');
    assert.equal((await finish(f,expired)).headers.get('Location'),'/?google=failed');
    const changed=await begin(f); await configure(f,{enabled:false,clientSecret:''});
    assert.equal((await finish(f,changed)).headers.get('Location'),'/settings/personal?google=failed');
  } finally {f.close();}
});

test('password proof, duplicate Google subject, revoked session and changed credentials protect bindings',async()=>{
  const f=await fixture(); try {
    await configure(f);
    assert.equal((await f.api('account/google/bind','POST',{currentPassword:'wrong'})).status,401);
    const tx=await begin(f); await finish(f,tx);
    const member=await f.signIn('member');
    const duplicate=await begin(f,'bind',member); assert.equal((await finish(f,duplicate)).headers.get('Location'),'/settings/personal?google=binding_failed');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM account_google_bindings').get().n,1);
    const revoked=await begin(f,'bind',member);
    f.sqlite.prepare('UPDATE account_sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(),member.session.tokenHash);
    assert.equal((await finish(f,revoked,{overrides:{sub:'member-google'}})).headers.get('Location'),'/settings/personal?google=binding_failed');
    const again=await f.signIn('member'), changed=await begin(f,'bind',again);
    assert.equal((await finish(f,changed,{overrides:{sub:'member-google'},mutate:()=>f.sqlite.exec("UPDATE account_credentials SET password_hash='changed' WHERE account_id='member'")})).headers.get('Location'),'/settings/personal?google=binding_failed');
  } finally {f.close();}
});

test('unbound, disabled and forced-password-change accounts cannot obtain Google sessions; unbind revokes all sessions',async()=>{
  const f=await fixture(); try {
    await configure(f);
    assert.equal((await finish(f,await begin(f,'login'))).headers.get('Location'),'/?google=unbound');
    await finish(f,await begin(f));
    const tx=await begin(f,'login');
    f.sqlite.exec("UPDATE account_credentials SET must_change_password=1 WHERE account_id=(SELECT account_id FROM accounts WHERE username='owner')");
    assert.equal((await finish(f,tx)).headers.get('Location'),'/?google=failed');
    f.sqlite.exec('UPDATE account_credentials SET must_change_password=0');
    const member=await f.signIn('member'), mtx=await begin(f,'bind',member); await finish(f,mtx,{overrides:{sub:'member-google'}});
    const login=await begin(f,'login'); f.sqlite.exec("UPDATE accounts SET status='disabled' WHERE account_id='member'");
    assert.equal((await finish(f,login,{overrides:{sub:'member-google'}})).headers.get('Location'),'/?google=failed');
    const res=await f.api('account/google/unbind','POST',{currentPassword:PASSWORD});assert.equal(res.status,200,await res.clone().text());
    assert.equal(await getSessionAfterReadyCheck({db:f.db,token:tokenFromCookie(f.signed.cookie)}),null);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM account_google_bindings WHERE account_id=?').get(f.owner).n,0);
  } finally {f.close();}
});

test('HTTP policy requires same-origin CSRF and admin permissions; secret rotation and old schema fail closed',async()=>{
  const f=await fixture(); try {
    const member=await f.signIn('member');
    assert.equal((await f.api('admin/google','GET',undefined,member)).status,403);
    assert.equal((await f.api('account/google/bind','POST',{currentPassword:PASSWORD},undefined,{'X-CSRF-Token':''})).status,403);
    assert.equal((await f.api('auth/google/start','POST',{},undefined,{Origin:'https://evil.example'})).status,403);
    await configure(f);
    const stale=await f.api('admin/google','PUT',{enabled:true,clientId,clientSecret:'',callbackOrigin:'https://test.example',revision:0});assert.equal(stale.status,409);
    f.env.SETUP_SECRET='rotated-only-local-test-secret-at-least-32-chars';
    assert.deepEqual(await (await f.api('auth/google/status')).json(),{enabled:false});
    assert.equal((await f.api('auth/google/start','POST',{})).status,503);
    f.sqlite.exec('DROP TRIGGER google_credentials_changed; DROP TRIGGER google_account_changed; DROP TABLE google_login_transactions; DROP TABLE account_google_bindings; DROP TABLE google_login_config');
    assert.deepEqual(await (await f.api('auth/google/status')).json(),{enabled:false});
    assert.equal((await f.api('auth/session')).status,200);
    await runKnownDatabaseUpgrade(f.db);
    assert.equal((await (await f.api('admin/google')).json()).ready,true);
  } finally {f.close();}
});

test('Google token checks reject issuer, audience, azp, nonce, expiry, subject, email, algorithm and signature tampering',async()=>{
  const fetchKeys=async()=>Response.json({keys:[jwk]});
  assert.equal((await verifyGoogleIdToken(await signedToken('nonce'),clientId,'nonce',fetchKeys)).sub,'google-owner');
  for (const change of [{iss:'https://evil.example'},{aud:'other'},{azp:'other'},{nonce:'other'},{exp:1},{iat:Math.floor(Date.now()/1000)+1000},{sub:''},{sub:12},{email_verified:false}]) {
    await assert.rejects(()=>signedToken('nonce',change).then(token=>verifyGoogleIdToken(token,clientId,'nonce',fetchKeys)));
  }
  await assert.rejects(()=>signedToken('nonce',{}, {alg:'HS256'}).then(token=>verifyGoogleIdToken(token,clientId,'nonce',fetchKeys)));
  const token=await signedToken('nonce'); const parts=token.split('.');
  const badSignature=Buffer.from(parts[2],'base64url'); badSignature[0]^=1; parts[2]=badSignature.toString('base64url');
  await assert.rejects(()=>verifyGoogleIdToken(parts.join('.'),clientId,'nonce',fetchKeys));
});

test('actual password change invalidates an already-started Google login, including a change during token exchange',async()=>{
  const f=await fixture(); try {
    await configure(f); await finish(f,await begin(f));
    const tx=await begin(f,'login');
    const changed=await f.api('auth/change-password','POST',{currentPassword:PASSWORD,newPassword:'replacement-password-2026'});
    assert.equal(changed.status,200,await changed.clone().text());
    const response=await finish(f,tx); assert.equal(response.headers.get('Location'),'/?google=failed');
    assert.ok(!response.headers.get('Set-Cookie').includes('__Host-ft_session='));
    const newer=await begin(f,'login');
    const raced=await finish(f,newer,{mutate:()=>f.sqlite.exec("UPDATE account_credentials SET must_change_password=1 WHERE account_id='member'")});
    assert.equal(raced.headers.get('Location'),'/?google=failed');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM account_sessions WHERE revoked_at IS NULL').get().n,0);
  } finally {f.close();}
});

test('configuration audit and config write commit together; partial Google schema rejects upgrade',async()=>{
  const f=await fixture(); try {
    await configure(f);
    const audit=f.sqlite.prepare("SELECT actor_account_id,action,target_id,result FROM audit_events WHERE action='google.configure'").get();
    assert.equal(audit.actor_account_id,f.owner);assert.equal(audit.result,'success');
    const before=f.sqlite.prepare('SELECT * FROM google_login_config').get();
    f.db.fail=/INSERT INTO audit_events/;
    const failed=await f.api('admin/google','PUT',{enabled:false,clientId,clientSecret:'',callbackOrigin:'https://test.example',revision:before.revision});
    assert.equal(failed.status,503);assert.deepEqual(f.sqlite.prepare('SELECT * FROM google_login_config').get(),before);
    f.db.fail=null; f.sqlite.exec('DROP TABLE google_login_transactions');
    await assert.rejects(()=>runKnownDatabaseUpgrade(f.db),{code:'migration_schema_inconsistent'});
  } finally {f.close();}
});

async function beginNative(f, verifier = 'native_pkce_verifier_example_0123456789_abcdefg', ip = '192.0.2.10') {
  const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const response = await handleGoogleRequest(
    new Request(`https://test.example/auth/google/native/start?challenge=${challenge}`, { method: 'GET', headers: { 'CF-Connecting-IP': ip } }),
    f.env, '/auth/google/native/start', null, json);
  assert.equal(response.status, 303);
  const url = new URL(response.headers.get('Location'));
  assert.equal(url.origin, 'https://accounts.google.com');
  return { url, verifier, cookie: response.headers.get('Set-Cookie').split(';')[0] };
}

test('native Google login issues one-time PKCE handoff code, exchanges for session and blocks replay or tampering', async () => {
  const f = await fixture(); try {
    assert.deepEqual(await (await f.api('auth/google/status?client=android')).json(), { enabled: false, nativeEnabled: false });
    await configure(f);
    assert.deepEqual(await (await f.api('auth/google/status')).json(), { enabled: true });
    assert.deepEqual(await (await f.api('auth/google/status?client=android')).json(), { enabled: true, nativeEnabled: true });
    await finish(f, await begin(f));

    const nativeTx = await beginNative(f);
    const cb = await finish(f, nativeTx);
    assert.equal(cb.status, 303);
    const redirect = new URL(cb.headers.get('Location'));
    assert.equal(`${redirect.protocol}//${redirect.host}${redirect.pathname}`, 'flaretune://auth/google/callback');
    const handoffCode = redirect.searchParams.get('code');
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(handoffCode));
    const cbCookies = cb.headers.getSetCookie();
    assert.ok(cbCookies.some(c => c.includes('__Host-ft_google_transaction=;')));
    assert.ok(!cbCookies.some(c => c.startsWith('__Host-ft_session=')));

    // Wrong verifier fails without leaking session or consuming the real app's code.
    assert.equal((await f.api('auth/google/exchange', 'POST', { code: handoffCode, codeVerifier: 'wrong_verifier_0123456789_abcdefghijklmnopqrstuvwxyz' })).status, 401);

    // Real verifier succeeds and returns standard session JSON + __Host-ft_session cookie.
    const exchanged = await f.api('auth/google/exchange', 'POST', { code: handoffCode, codeVerifier: nativeTx.verifier });
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const payload = await exchanged.json();
    assert.equal(payload.authenticated, true);
    assert.equal(payload.mustChangePassword, false);
    assert.equal(payload.user.accountId, f.owner);
    assert.ok(payload.csrfToken);
    const sessionCookie = exchanged.headers.get('Set-Cookie');
    assert.ok(sessionCookie && sessionCookie.startsWith('__Host-ft_session='));
    const session = await getSessionAfterReadyCheck({ db: f.db, token: tokenFromCookie(sessionCookie.split(';')[0]) });
    assert.equal(session.account.accountId, f.owner);

    // Replay is rejected.
    assert.equal((await f.api('auth/google/exchange', 'POST', { code: handoffCode, codeVerifier: nativeTx.verifier })).status, 401);
  } finally { f.close(); }
});

test('native Google login handles cancellation, unbound accounts, expiry, credential changes and missing table', async () => {
  const f = await fixture(); try {
    await configure(f);
    const unboundTx = await beginNative(f, undefined, '192.0.2.11');
    assert.equal((await finish(f, unboundTx)).headers.get('Location'), 'flaretune://auth/google/callback?error=unbound');

    const cancelledTx = await beginNative(f, undefined, '192.0.2.12');
    assert.equal((await finish(f, cancelledTx, { error: 'access_denied' })).headers.get('Location'), 'flaretune://auth/google/callback?error=cancelled');

    const wrongBrowserTx = await beginNative(f, undefined, '192.0.2.13');
    assert.equal((await finish(f, wrongBrowserTx, { cookie: '' })).headers.get('Location'), 'flaretune://auth/google/callback?error=failed');

    await finish(f, await begin(f));
    const expiredTx = await beginNative(f, undefined, '192.0.2.14');
    const expiredCb = await finish(f, expiredTx);
    const expiredCode = new URL(expiredCb.headers.get('Location')).searchParams.get('code');
    f.sqlite.exec('UPDATE google_native_handoffs SET expires_at=1');
    assert.equal((await f.api('auth/google/exchange', 'POST', { code: expiredCode, codeVerifier: expiredTx.verifier })).status, 401);

    const changedTx = await beginNative(f, undefined, '192.0.2.15');
    const changedCb = await finish(f, changedTx);
    const changedCode = new URL(changedCb.headers.get('Location')).searchParams.get('code');
    const pwRes = await f.api('auth/change-password', 'POST', { currentPassword: PASSWORD, newPassword: 'replacement-password-2026' });
    assert.equal(pwRes.status, 200);
    assert.equal((await f.api('auth/google/exchange', 'POST', { code: changedCode, codeVerifier: changedTx.verifier })).status, 401);

    f.sqlite.exec('DROP TABLE google_native_handoffs');
    assert.deepEqual(await (await f.api('auth/google/status?client=android')).json(), { enabled: true, nativeEnabled: false });
    assert.deepEqual(await (await f.api('auth/google/status')).json(), { enabled: true });
    const unavailable = await handleGoogleRequest(
      new Request('https://test.example/auth/google/native/start?challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', { method: 'GET' }),
      f.env, '/auth/google/native/start', null, json);
    assert.equal(unavailable.headers.get('Location'), 'flaretune://auth/google/callback?error=google_unavailable');
    await runKnownDatabaseUpgrade(f.db);
    assert.deepEqual(await (await f.api('auth/google/status?client=android')).json(), { enabled: true, nativeEnabled: true });
  } finally { f.close(); }
});
