import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from '../../routes/localAssistant.fixture.js';
import { assistantImagePolicy, prepareAssistantImages } from './images.js';
import { uploadOwnImage } from '../../services/userImages.js';

function bytes() {
  const b = new Uint8Array(26), v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('RIFF')); v.setUint32(4,18,true); b.set(new TextEncoder().encode('WEBPVP8L'),8);
  v.setUint32(16,5,true); b[20]=47; v.setUint32(21,31|(31<<14),true); return b;
}
async function setup(t) {
  const f = fixture({ modelInitialized: false }); t.after(() => f.sqlite.close());
  f.sqlite.exec(readFileSync(new URL('../../../db/migrations-flaretune/0010_user_images.sql', import.meta.url), 'utf8'));
  const selection = { providerId: 'provider', model: 'vision', supportsImages: true, generationOptions: {}, providerBinding: 'connection-v1' };
  f.sqlite.prepare("INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES ('plugin.data.assistant.instance.ai-model',?,1,1,'account-A')")
    .run(JSON.stringify({ schemaVersion: 1, selection }));
  f.sqlite.exec("INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES ('assistant.images_enabled','true',1,1,'account-A')");
  const objects = new Map(), bucket = { async put(key, value) { objects.set(key, value); }, async get(key) { const data = objects.get(key); return data ? { arrayBuffer: async () => data.buffer } : null; }, async delete(key) { objects.delete(key); } };
  const image = await uploadOwnImage(f.db, bucket, 'account-A', 'chat', bytes());
  f.sqlite.exec("INSERT INTO music_chat_threads(account_id,revision,next_sequence,created_at,updated_at) VALUES ('account-A',0,2,1,1)");
  f.sqlite.exec("INSERT INTO music_chat_thread_messages(id,account_id,sequence,role,content,created_at) VALUES ('message','account-A',1,'user','Look',1)");
  f.sqlite.prepare("INSERT INTO user_image_refs(account_id,purpose,target_id,image_id,revision,message_id) VALUES ('account-A','chat','message_0',?,1,'message')").run(image.id);
  const config = { profileId: 'provider', model: 'vision', supportsImages: true, configurationRevision: 1, providerBinding: 'connection-v1' };
  const messages = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Look', privateMessageId: 'message', privateImageIds: [image.id] }];
  return { ...f, bucket, config, messages, selection };
}
const countImages = messages => messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url').length;

test('image policy uses the consumer revision and binding without querying gateway business tables', async t => {
  const f = await setup(t), prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => { assert.doesNotMatch(sql, /ai_model_profiles|ai_feature_assignments|ai_feature_models|ai\.images\./); return prepare(sql); };
  assert.equal((await assistantImagePolicy(f.db, f.config)).enabled, true);
  assert.equal((await assistantImagePolicy(f.db, { ...f.config, configurationRevision: 2 })).enabled, false);
  assert.equal((await assistantImagePolicy(f.db, { ...f.config, providerBinding: 'connection-v2' })).enabled, false);
  f.sqlite.exec("UPDATE instance_settings SET value_json='false' WHERE key='assistant.images_enabled'");
  assert.equal((await assistantImagePolicy(f.db, f.config)).enabled, false);
});
test('R2 reads cannot publish historical pixels after a model configuration change', async t => {
  const f = await setup(t), get = f.bucket.get;
  f.bucket.get = async key => { const object = await get(key);
    f.sqlite.exec("UPDATE instance_settings SET revision=revision+1 WHERE key='plugin.data.assistant.instance.ai-model'"); return object; };
  const result = await prepareAssistantImages(f.db, f.bucket, 'account-A', f.messages, f.config);
  assert.equal(result.included, 0); assert.equal(countImages(result.messages), 0); assert.equal(result.disabled, true);
  assert.doesNotMatch(JSON.stringify(result.messages), /base64/);
});
test('historical image replay checks the live authority before each round and after R2', async t => {
  const f = await setup(t); let checks = 0;
  const assertCurrent = async () => { checks += 1; if (checks === 2) throw Object.assign(new Error('PLUGIN_SERVICE_CONFIGURATION_CHANGED'), { code: 'PLUGIN_SERVICE_CONFIGURATION_CHANGED' }); };
  await assert.rejects(prepareAssistantImages(f.db, f.bucket, 'account-A', f.messages, f.config, assertCurrent), { code: 'PLUGIN_SERVICE_CONFIGURATION_CHANGED' });
  assert.equal(checks, 2);
  const first = await prepareAssistantImages(f.db, f.bucket, 'account-A', f.messages, f.config);
  assert.equal(countImages(first.messages), 1);
  f.sqlite.exec("UPDATE instance_settings SET revision=revision+1 WHERE key='plugin.data.assistant.instance.ai-model'");
  const next = await prepareAssistantImages(f.db, f.bucket, 'account-A', f.messages, f.config);
  assert.equal(countImages(next.messages), 0);
});
