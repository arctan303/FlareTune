import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from '../subsonic/test-support.js';
import { assistantBuildHeaders } from '../plugins/assistant/test-support.js';

// The inherited 0.1.0 package exposes this policy, not the new factory. Keep
// that missing-export shape in the module graph so a named import regresses
// at link time. The real pinned 0.1 artifact is also exercised at deployment.
const api1Module = 'data:text/javascript;base64,' + Buffer.from(`
  export async function assistantImagePolicy(db) {
    const row = await db.prepare("SELECT value_json FROM instance_settings WHERE key='assistant.images_enabled'").first();
    return { enabled: row?.value_json === 'true' };
  }
`).toString('base64');
const routeUrl = new URL('./userImages.js', import.meta.url);
const routeSource = (await readFile(routeUrl, 'utf8')).replace(/from '([^']+)'/g, (_, specifier) =>
  `from '${specifier === '../services/assistantImages.js' ? api1Module : new URL(specifier, routeUrl).href}'`);
const { handleUserImages } = await import('data:text/javascript;base64,' + Buffer.from(routeSource).toString('base64'));

function bytes() {
  const b = new Uint8Array(26), v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('RIFF')); v.setUint32(4, 18, true); b.set(new TextEncoder().encode('WEBPVP8L'), 8);
  v.setUint32(16, 5, true); b[20] = 47; v.setUint32(21, 31 | (31 << 14), true); return b;
}
async function setup(t) {
  const f = await fixture(); t.after(() => f.close());
  for (const id of ['ai-gateway', 'assistant']) f.sqlite.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES (?,?,1,1,?)`).run(`plugin.installation.${id}`, JSON.stringify({ installed: true, epoch: crypto.randomUUID() }), f.owner);
  f.sqlite.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES ('assistant.images_enabled','true',1,1,?)`).run(f.owner);
  const upload = async () => {
    const request = new Request('https://test.example/api/account/images/upload/chat', {
      method: 'POST', headers: { 'Content-Type': 'image/webp', ...assistantBuildHeaders() }, body: bytes(),
    });
    return handleUserImages(request, new URL(request.url), f.db, f.env.MEDIA_BUCKET, f.signed.session, { env: f.env });
  };
  return { ...f, upload };
}

test('an inherited API1 namespace links and uploads without requiring new consumer configuration', async t => {
  const f = await setup(t), response = await f.upload();
  assert.equal(response.status, 201, await response.clone().text());
  assert.ok((await response.json()).id);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_settings WHERE key='plugin.data.assistant.instance.ai-model'").get().n, 0);
});

test('API1 fallback checks the live image policy again after R2 upload', async t => {
  const f = await setup(t), put = f.env.MEDIA_BUCKET.put.bind(f.env.MEDIA_BUCKET);
  f.env.MEDIA_BUCKET.put = async (...args) => {
    await put(...args);
    f.sqlite.exec("UPDATE instance_settings SET value_json='false' WHERE key='assistant.images_enabled'");
  };
  const response = await f.upload();
  assert.equal(response.status, 403); assert.equal((await response.json()).error, 'assistant_images_disabled');
});

test('API1 fallback retains transaction authority when the session retires during R2', async t => {
  const f = await setup(t), put = f.env.MEDIA_BUCKET.put.bind(f.env.MEDIA_BUCKET);
  f.env.MEDIA_BUCKET.put = async (...args) => { await put(...args); f.sqlite.exec('UPDATE account_sessions SET revoked_at=1'); };
  assert.notEqual((await f.upload()).status, 201);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM user_images WHERE purpose='chat' AND status='ready'").get().n, 0);
});

test('API1 fallback cannot upload after the assistant is uninstalled', async t => {
  const f = await setup(t);
  f.sqlite.exec("UPDATE instance_settings SET value_json='{}' WHERE key='plugin.installation.assistant'");
  assert.equal((await f.upload()).status, 409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM user_images').get().n, 0);
});
