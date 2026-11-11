import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../flaretune.js';
import { fixture } from '../subsonic/test-support.js';
import { assistantBuildHeaders } from '../plugins/assistant/test-support.js';
import { createAiProfile, assignAiProfile } from '../instanceAdmin/aiProfiles.js';

function bytes() {
  const b = new Uint8Array(26), v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('RIFF')); v.setUint32(4,18,true); b.set(new TextEncoder().encode('WEBPVP8L'),8);
  v.setUint32(16,5,true); b[20]=47; v.setUint32(21,31|(31<<14),true); return b;
}
async function setup(t, { initialize = true } = {}) {
  const f = await fixture(); t.after(() => f.close());
  for (const id of ['ai-gateway', 'assistant']) f.sqlite.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES (?,?,1,1,?)`).run(`plugin.installation.${id}`, JSON.stringify({ installed: true, epoch: crypto.randomUUID() }), f.owner);
  const profile = await createAiProfile(f.db, f.owner, { name: 'Image model fixture', source: 'custom', protocol: 'chat_completions',
    baseUrl: 'https://models.example/v1', model: 'vision', apiKey: 'image-fixture-key', supportsImages: true }, f.env);
  await assignAiProfile(f.db, f.owner, 'assistant', profile.id, 0);
  if (initialize) {
    const result = await f.api('admin/plugins/assistant/model/initialize', 'POST', { expectedRevision: 0 }, f.signed, assistantBuildHeaders());
    assert.equal(result.status, 200, await result.clone().text());
  }
  const settings = await f.api('admin/plugins/assistant/settings/images', 'PUT', { value: true, expectedRevision: 0 }, f.signed, assistantBuildHeaders());
  assert.equal(settings.status, 200, await settings.clone().text());
  const upload = (overrides = {}) => worker.fetch(new Request('https://test.example/api/account/images/upload/chat', {
    method: 'POST', headers: { Cookie: f.signed.cookie, Origin: 'https://test.example', 'X-Requested-With': 'FlareTune',
      'X-CSRF-Token': f.signed.session.csrfToken, 'Content-Type': 'image/webp', 'CF-Connecting-IP': '192.0.2.22', ...assistantBuildHeaders(), ...overrides }, body: bytes(),
  }), f.env);
  return { ...f, upload };
}

test('HTTP chat image upload requires explicit model initialization, build identity and CSRF', async t => {
  const f = await setup(t, { initialize: false });
  const absent = await f.upload(); assert.equal(absent.status, 409); assert.equal((await absent.json()).error, 'PLUGIN_UPDATE_REQUIRED');
  assert.equal((await f.upload({ 'X-FlareTune-Plugin-Build': '0'.repeat(64) })).status, 409);
  assert.equal((await f.upload({ 'X-CSRF-Token': '' })).status, 403);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM user_images WHERE purpose='chat'").get().n, 0);
});
test('HTTP chat image upload uses the saved visual declaration and does not return provider credentials', async t => {
  const f = await setup(t);
  const response = await f.upload(); assert.equal(response.status, 201, await response.clone().text());
  const dto = await response.json(); assert.ok(dto.id); assert.equal(dto.url, `/api/account/images/${dto.id}`);
  assert.doesNotMatch(JSON.stringify(dto), /image-fixture-key|SETUP_SECRET|providerBinding|apiKey|base64/);
  f.sqlite.exec("UPDATE instance_settings SET value_json=json_set(value_json,'$.selection.supportsImages',json('false')),revision=revision+1 WHERE key='plugin.data.assistant.instance.ai-model'");
  const disabled = await f.upload(); assert.equal(disabled.status, 403); assert.equal((await disabled.json()).error, 'assistant_images_disabled');
});
test('a configuration revision changed during R2 upload cannot mark the old upload ready or return success', async t => {
  const f = await setup(t), put = f.env.MEDIA_BUCKET.put.bind(f.env.MEDIA_BUCKET); let raced = false;
  f.env.MEDIA_BUCKET.put = async (...args) => {
    await put(...args); raced = true;
    f.sqlite.exec("UPDATE instance_settings SET revision=revision+1 WHERE key='plugin.data.assistant.instance.ai-model'");
  };
  const response = await f.upload(); assert.equal(raced, true); assert.notEqual(response.status, 201);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM user_images WHERE purpose='chat' AND status='ready'").get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM user_image_refs').get().n, 0);
});
