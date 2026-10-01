import assert from 'node:assert/strict';
import test from 'node:test';
import { startPreview } from '../dev/preview-worker.mjs';

test('isolated workerd serves Google config, encrypted credentials, same-origin start and browser-bound callbacks',async()=>{
  const setupSecret='local-google-http-test-setup-secret-2026';
  const preview=await startPreview({ephemeral:true,seedEmpty:true,workerTestBindings:{SETUP_SECRET:setupSecret}});
  const api=(path,options)=>fetch(preview.origin+path,options);
  const post=(path,body,headers={},method='POST')=>api(path,{method,headers:{
    Origin:preview.origin,'Content-Type':'application/json','X-Requested-With':'FlareTune','CF-Connecting-IP':'192.0.2.41',...headers},body:JSON.stringify(body)});
  try {
    assert.equal((await api('/api/auth/google/status')).status,503);
    const {proof}=await (await post('/api/auth/verify-setup',{setupSecret})).json();
    assert.equal((await post('/api/auth/setup',{proof,username:'owner',password:'local-http-password-2026'})).status,201);
    assert.deepEqual(await (await api('/api/auth/google/status')).json(),{enabled:false});
    const logged=await post('/api/auth/login',{username:'owner',password:'local-http-password-2026'});
    const cookie=logged.headers.get('Set-Cookie').split(';')[0];const {csrfToken}=await logged.json();
    const auth={Cookie:cookie,'X-CSRF-Token':csrfToken};
    const config={enabled:true,clientId:'fixture.apps.googleusercontent.com',clientSecret:'local-http-fake-secret',callbackOrigin:preview.origin,revision:0};
    assert.equal((await post('/api/admin/google',config,{Cookie:cookie},'PUT')).status,403);
    assert.equal((await post('/api/admin/google',config,auth,'PUT')).status,200);
    const saved=await (await api('/api/admin/google',{headers:{Cookie:cookie}})).json();
    assert.equal(saved.secretReady,true);assert.equal(saved.revision,1);assert.ok(!JSON.stringify(saved).includes(config.clientSecret));
    assert.deepEqual(await (await api('/api/auth/google/status')).json(),{enabled:true});
    assert.equal((await post('/api/auth/google/start',{}, {Origin:'https://untrusted.example'})).status,403);
    const started=await post('/api/auth/google/start',{});assert.equal(started.status,200);
    const googleUrl=new URL((await started.json()).url);assert.equal(googleUrl.origin,'https://accounts.google.com');
    assert.equal(googleUrl.searchParams.get('redirect_uri'),preview.origin+'/auth/google/callback');
    assert.equal(googleUrl.searchParams.get('code_challenge_method'),'S256');assert.ok(googleUrl.searchParams.get('nonce'));
    const transactionCookie=started.headers.get('Set-Cookie');assert.match(transactionCookie,/HttpOnly; SameSite=Lax/);
    const callback='/auth/google/callback?state='+googleUrl.searchParams.get('state')+'&error=access_denied';
    const wrong=await api(callback,{redirect:'manual'});assert.equal(wrong.status,303);assert.equal(wrong.headers.get('Location'),'/?google=failed');
    const cancelled=await api(callback,{headers:{Cookie:transactionCookie.split(';')[0]},redirect:'manual'});
    assert.equal(cancelled.headers.get('Location'),'/?google=cancelled');
    const replay=await api(callback,{headers:{Cookie:transactionCookie.split(';')[0]},redirect:'manual'});
    assert.equal(replay.headers.get('Location'),'/?google=failed');
    assert.equal((await post('/api/account/google/bind',{currentPassword:'wrong'},auth)).status,401);
    const bound=await post('/api/account/google/bind',{currentPassword:'local-http-password-2026'},auth);assert.equal(bound.status,200);
    const bindUrl=new URL((await bound.json()).url),bindCookie=bound.headers.get('Set-Cookie').split(';')[0];
    const cancelBind=await api('/auth/google/callback?state='+bindUrl.searchParams.get('state')+'&error=access_denied',{
      headers:{Cookie:bindCookie},redirect:'manual'});
    assert.equal(cancelBind.headers.get('Location'),'/settings/personal?google=cancelled');
    assert.equal((await post('/api/admin/google',{...config,clientSecret:'',revision:1,enabled:false},auth,'PUT')).status,200);
    assert.deepEqual(await (await api('/api/auth/google/status')).json(),{enabled:false});
  } finally {await preview.stop();}
});
