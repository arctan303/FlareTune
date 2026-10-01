import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './localAssistant.fixture.js';
import { handleLocalAssistantRoute } from './localAssistant.js';
import { uploadOwnImage, cleanupOwnImages } from '../services/userImages.js';
import { createAiProfile, assignAiProfile } from '../instanceAdmin/aiProfiles.js';
import { chatAI } from '../services/ai.js';
import { KNOWN_MIGRATIONS } from '../instance/schemaManifest.js';
import { saveAiFeatureModel } from '../instanceAdmin/aiProviders.js';
function bytes() {
  const b = new Uint8Array(26); const v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('RIFF')); v.setUint32(4,18,true); b.set(new TextEncoder().encode('WEBPVP8L'),8); v.setUint32(16,5,true); b[20]=47; v.setUint32(21,31|(31<<14),true); return b;
}
async function setup(protocol = 'chat_completions') {
  const f = fixture(); f.sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0010_user_images.sql', import.meta.url),'utf8'));
  f.sqlite.exec("UPDATE accounts SET role = 'admin' WHERE account_id = 'account-A'");
  const migration = KNOWN_MIGRATIONS.find(m => m.version === 2);
  f.sqlite.prepare("INSERT INTO ft_migrations(version,name,checksum,stage,state,started_at,completed_at) VALUES (?,?,?,?,'completed',1,1)")
    .run(migration.version,migration.name,migration.checksum,migration.stage);
  f.sqlite.exec("UPDATE ft_instance SET schema_version = 2, initialized_at = 1 WHERE id = 1");
  f.sqlite.prepare(`INSERT INTO account_credentials(account_id,kdf,kdf_version,kdf_params_json,salt,password_hash,must_change_password,updated_at)
    VALUES ('account-A','pbkdf2-sha256-chain',2,'{"iterations":100000,"rounds":6}',?,?,0,1)`)
    .run(Buffer.alloc(16,1).toString('base64url'),Buffer.alloc(32,2).toString('base64url'));
  const objects = new Map();
  const bucket = { async put(key,value) { objects.set(key,value); }, async get(key) { return objects.has(key) ? { body: objects.get(key), arrayBuffer: async () => objects.get(key).buffer } : null; }, async delete(key) { objects.delete(key); } };
  const env = { SETUP_SECRET: 'image-fixture-secret-at-least-32-characters', MEDIA_BUCKET: bucket };
  const profile = await createAiProfile(f.db,'account-A',{ name:'Vision fixture', source:'custom', protocol, baseUrl:'https://models.example/v1', model:'fixture', apiKey:'fake-only', supportsImages:true },env);
  await assignAiProfile(f.db,'account-A','assistant',profile.id,0);
  f.sqlite.prepare("INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES ('assistant.images_enabled','true',1,1,'account-A')").run();
  const route = (body, chat, owner='account-A', method='POST', path='/api/ai/chat') => {
    const request = f.request(path,method,body);
    return handleLocalAssistantRoute(request,new URL(request.url),f.db,{},f.session(owner),env,{ chat });
  };
  return { ...f, env, profile, bucket, objects, route, image: owner => uploadOwnImage(f.db,bucket,owner || 'account-A','chat',bytes()) };
}
const events = async r => (await r.text()).split('\n\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
const body = (revision, imageIds = [], message = '看图') => ({ revision, image_ids:imageIds, message, client_message_id:crypto.randomUUID(), enable_thinking:false });
const countImages = m => m.flatMap(x => Array.isArray(x.content) ? x.content : []).filter(x=>x.type==='image_url').length;
const reply = async () => ({ type:'content',content:'收到' });
test('changing model on the same provider during a tool round strips images from the in-flight old model', async () => {
  const f = await setup();
  try {
    f.sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0011_ai_feature_models.sql', import.meta.url), 'utf8'));
    const image = await f.image(); let round = 0;
    const result = await events(await f.route(body(0, [image.id]), async messages => {
      if (round++ === 0) {
        assert.equal(countImages(messages), 1);
        // Both old/new models declared vision. Revision, not just Boolean,
        // prevents the old request from continuing with historical pixels.
        await saveAiFeatureModel(f.db, 'account-A', { feature: 'assistant', providerId: f.profile.id,
          providerRevision: 1, expectedRevision: 1, model: 'different-vision-model', supportsImages: true }, f.env);
        return { type: 'function_calls', functionCalls: [{ id: 'clock', name: 'current_time', args: {} }] };
      }
      assert.equal(countImages(messages), 0); return reply();
    }));
    assert.equal(round, 2); assert.ok(result.some(item => item.type === 'done'));
  } finally { f.sqlite.close(); }
});
test('image-only submission persists references, replays original blocks and isolates another account', async () => {
  const f = await setup(); const image = await f.image(); let first;
  const chunks = await events(await f.route(body(0,[image.id],''),async messages => { first=messages; return reply(); }));
  assert.equal(countImages(first),1); assert.ok(chunks.some(x=>x.type==='done'));
  const thread = chunks.find(x=>x.type==='thread_state').thread;
  assert.deepEqual(thread.messages[0].images,[{id:image.id,url:image.url}]);
  const saved = f.sqlite.prepare("SELECT extra_json FROM music_chat_thread_messages WHERE role = 'user'").get().extra_json;
  assert.ok(!saved.includes('base64')); assert.ok(!saved.includes('object_key'));
  await events(await f.route(body(thread.revision,[],'接着说'),async messages => { assert.equal(countImages(messages),1); return reply(); }));
  const foreign = await f.route(body(0,[image.id]),reply,'account-B'); assert.equal(foreign.status,404);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM music_chat_turns WHERE account_id = 'account-B'").get().n,0);
  await cleanupOwnImages(f.db,f.bucket,'account-A',{now:Date.now()+86400001}); assert.equal(f.objects.size,1);
  f.sqlite.close();
});
test('default/disabled gate rejects new attachments, strips old pixels and keeps own history', async () => {
  const f = await setup(); const image = await f.image(); await events(await f.route(body(0,[image.id]),reply));
  f.sqlite.exec("UPDATE instance_settings SET value_json = 'false' WHERE key = 'assistant.images_enabled'");
  assert.equal((await f.route(body(2,[image.id]),reply)).status,403);
  const result = await events(await f.route(body(2,[],'继续文本'),async messages => { assert.equal(countImages(messages),0); assert.ok(!JSON.stringify(messages).includes('base64')); return reply(); }));
  assert.ok(result.some(x=>x.type==='image_notice'));
  assert.equal(result.find(x=>x.type==='thread_state').thread.messages[0].images[0].id,image.id);
  f.sqlite.close();
});
test('gate is rechecked after a tool round, and a non-vision profile cannot receive pixels', async () => {
  const f = await setup(); const image = await f.image(); let round=0;
  const result = await events(await f.route(body(0,[image.id]),async messages => {
    if (round++ === 0) {
      assert.equal(countImages(messages),1); f.sqlite.exec("UPDATE instance_settings SET value_json = 'false' WHERE key = 'assistant.images_enabled'");
      return {type:'function_calls',functionCalls:[{id:'clock',name:'current_time',args:{}}]};
    }
    assert.equal(countImages(messages),0); return reply();
  })); assert.equal(round,2); assert.ok(result.some(x=>x.type==='done'));
  f.sqlite.exec(`UPDATE instance_settings SET value_json = 'true' WHERE key = 'assistant.images_enabled'; UPDATE instance_settings SET value_json = 'false' WHERE key LIKE 'ai.images.%'`);
  assert.equal((await f.route(body(2,[image.id]),reply)).status,403);
  await events(await f.route(body(2,[],'继续'),async messages => { assert.equal(countImages(messages),0); return reply(); })); f.sqlite.close();
});
test('history includes at most latest 4 images, expires after 24 messages and reports it', async () => {
  const f = await setup(); const pictures = await Promise.all(Array.from({length:5},()=>f.image()));
  await events(await f.route(body(0,pictures.slice(0,4).map(x=>x.id)),reply));
  const second = await events(await f.route(body(2,[pictures[4].id]),async messages => { assert.equal(countImages(messages),4); return reply(); }));
  assert.ok(second.some(x=>x.type==='image_notice'));
  for(let rev=4;rev<28;rev+=2) await events(await f.route(body(rev,[],'文本'),reply));
  const last = await events(await f.route(body(28,[],'旧图呢'),async messages => { assert.equal(countImages(messages),0); assert.match(messages[0].content,/超出上下文窗口/); return reply(); }));
  assert.ok(last.some(x=>x.type==='image_notice')); f.sqlite.close();
});
test('failed, duplicate and concurrent turns retain only their correctly owned references', async () => {
  const f=await setup(); const image=await f.image(); const input=body(0,[image.id]);
  const failed=await events(await f.route(input,async()=>{throw new Error('AI_UPSTREAM_FAILURE');})); assert.ok(failed.some(x=>x.type==='error'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_image_refs').get().n,1);
  const duplicate=await f.route(input,reply); assert.equal(duplicate.status,409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_image_refs').get().n,1);
  assert.equal((await f.route(body(0,[image.id]),reply)).status,409);
  const cleared=await f.route({revision:2},reply,'account-A','DELETE','/api/ai/thread'); assert.equal(cleared.status,200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_image_refs').get().n,0); f.sqlite.close();
});
const streams = {
  chat_completions:[{choices:[{delta:{content:'收到'}}]},'[DONE]'],
  responses:[{type:'response.output_text.delta',delta:'收到'},{type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'收到'}]}]}}],
  anthropic_messages:[{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'收到'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}],
  gemini_native:[{candidates:[{content:{parts:[{text:'收到'}]},finishReason:'STOP'}]}],
};
for (const [protocol,chunks] of Object.entries(streams)) test(`${protocol} real assistant attachment becomes a native provider image block`,async t=>{
  const f=await setup(protocol); const image=await f.image();
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    const payload=JSON.parse(init.body); const wire=JSON.stringify(payload);
    assert.ok(wire.includes({chat_completions:'image_url',responses:'input_image',anthropic_messages:'"type":"image"',gemini_native:'inlineData'}[protocol]));
    assert.ok(wire.includes('image/webp')); assert.ok(!wire.includes('/api/account/images/')); assert.ok(!wire.includes('privateMessageId'));
    return new Response(chunks.map(x=>`data: ${typeof x==='string'?x:JSON.stringify(x)}\n\n`).join(''));
  });
  const result=await events(await f.route(body(0,[image.id]),chatAI)); assert.ok(result.some(x=>x.type==='done'),JSON.stringify(result)); f.sqlite.close();
});
