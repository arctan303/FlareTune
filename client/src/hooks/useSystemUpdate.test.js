import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, createBackgroundScheduler, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

const session = id => ({ authenticated: true, csrfToken: 'csrf-' + id, user: { accountId: id, role: 'admin' } });
function subject({ demo = false } = {}) {
  const requests = [], scheduler = createBackgroundScheduler();
  const service = {
    systemUpdateErrorMessage: error => error.code,
    systemUpdateRequest: (owner, path, options) => new Promise((resolve, reject) => requests.push({ owner, path, options, resolve, reject })),
    recheckSystemUpdateStatus: async () => false,
  };
  const hook = createBackgroundModuleHarness({ file: new URL('./useSystemUpdate.js', import.meta.url),
    render: (module, props) => module.useSystemUpdate(props.session),
    modules: { '../services/runtimeFetch.js': { isDemoRuntime: demo }, '../services/systemUpdate.js': service },
    globals: { AbortController, ...scheduler } });
  return { ...hook, requests, scheduler, service };
}

test('system update data is discarded and requests aborted when the account changes', async () => {
  const s = subject();
  s.render({ session: session('A') }); s.render({ session: session('B') });
  assert.equal(s.requests[0].options.signal.aborted, true);
  s.requests[0].resolve({ revision: 7, current: { version: 'private-A' } });
  await flushBackgroundAsync(); assert.equal(s.render().data, null);
  s.requests[1].resolve({ revision: 2, current: { version: '1.2.1' } });
  await flushBackgroundAsync(); assert.equal(s.render().data.revision, 2);
  const member = { ...session('B'), user: { accountId: 'B', role: 'member' } };
  assert.equal(s.render({ session: member }).data, null);
  assert.equal(s.render({ session: { ...session('B'), mustChangePassword: true } }).data, null);
  assert.equal(s.requests.length, 2); s.unmount();
});

test('Demo never reads or mutates the real update service', async () => {
  const s = subject({ demo: true });
  const view = s.render({ session: session('A') });
  await view.action('/start', 'POST', { releaseId: 'fixture' });
  await view.refresh();
  assert.equal(view.demo, true); assert.equal(s.requests.length, 0); s.unmount();
});

test('writes use the latest confirmed revision and suppress duplicate submissions', async () => {
  const s = subject(); s.render({ session: session('A') });
  s.requests[0].resolve({ revision: 7, job: null }); await flushBackgroundAsync();
  const view = s.render();
  const request = view.action('/start', 'POST', { releaseId: 'approved', revision: 999 });
  await view.action('/start', 'POST', { releaseId: 'other' });
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[1].options.body.revision, 7);
  s.requests[1].resolve({ revision: 8, job: { taskId: 'task-1', status: 'queued' } });
  await request;
  assert.equal(s.render().data.revision, 8); assert.equal(s.scheduler.intervals.size, 1);
  s.unmount(); assert.equal(s.scheduler.intervals.size, 0);
});

test('a late refresh cannot overwrite the newly accepted update task', async () => {
  const s = subject(); s.render({ session: session('A') });
  s.requests[0].resolve({ revision: 1, job: null }); await flushBackgroundAsync();
  const view = s.render(), read = view.refresh();
  const write = view.action('/start', 'POST', { releaseId: 'approved' });
  s.requests[2].resolve({ revision: 2, job: { taskId: 'accepted', status: 'queued' } }); await write;
  s.requests[1].resolve({ revision: 1, job: null }); await read;
  assert.equal(s.render().data.job.taskId, 'accepted'); s.unmount();
});

test('a failed write response reloads actual state and retains its error for safe recovery', async () => {
  const s = subject(); s.render({ session: session('A') });
  s.requests[0].resolve({ revision: 3, job: null }); await flushBackgroundAsync();
  const request = s.render().action('/start', 'POST', { releaseId: 'approved' });
  s.requests[1].reject({ code: 'SYSTEM_UPDATE_RESULT_UNKNOWN' }); await flushBackgroundAsync();
  assert.equal(s.requests[2].path, '');
  s.requests[2].resolve({ revision: 4, job: { taskId: 'same-task', status: 'activation_pending' } }); await request;
  const view = s.render();
  assert.equal(view.data.job.taskId, 'same-task'); assert.equal(view.error, 'SYSTEM_UPDATE_RESULT_UNKNOWN');
  assert.equal(s.scheduler.intervals.size, 1);
  const retry = view.action('/retry', 'POST', { taskId: view.data.job.taskId });
  assert.deepEqual(JSON.parse(JSON.stringify(s.requests[3].options.body)), { revision: 4, taskId: 'same-task' });
  s.requests[3].resolve({ revision: 5, job: { taskId: 'same-task', status: 'deployed' } }); await retry;
  s.render(); assert.equal(s.scheduler.intervals.size, 0); s.unmount();
});

test('remounting reads and resumes the persisted task instead of creating a new one', async () => {
  const first = subject(); first.render({ session: session('A') });
  first.requests[0].resolve({ revision: 5, job: { taskId: 'persisted', status: 'migrating' } });
  await flushBackgroundAsync(); first.render(); first.unmount();
  const second = subject(); second.render({ session: session('A') });
  assert.equal(second.requests[0].path, '');
  second.requests[0].resolve({ revision: 5, job: { taskId: 'persisted', status: 'migrating' } });
  await flushBackgroundAsync(); const view = second.render();
  assert.equal(view.data.job.taskId, 'persisted'); assert.equal(second.requests.length, 1);
  assert.equal(second.scheduler.intervals.size, 1); second.unmount();
});

test('an old write cannot unlock a newer write after returning to the same account', async () => {
  const s = subject(), ownerA = session('A'); s.render({ session: ownerA });
  s.requests[0].resolve({ revision: 1, job: null }); await flushBackgroundAsync();
  const oldWrite = s.render().action('/check');
  s.render({ session: session('B') });
  s.render({ session: ownerA });
  s.requests[3].resolve({ revision: 4, job: null }); await flushBackgroundAsync();
  const newerWrite = s.render().action('/check');
  s.requests[1].resolve({ revision: 2, job: null }); await oldWrite;
  await s.render().action('/check');
  assert.equal(s.requests.length, 5);
  s.requests[4].resolve({ revision: 5, job: null }); await newerWrite;
  assert.equal(s.render().data.revision, 5); s.unmount();
});

test('maintenance rechecks carry a live account guard and drop late owner results', async () => {
  const s = subject(); let context, finish;
  s.service.recheckSystemUpdateStatus = options => { context = options; return new Promise(resolve => { finish = resolve; }); };
  s.render({ session: session('A') });
  s.requests[0].reject({ status: 503, code: 'maintenance' }); await flushBackgroundAsync();
  assert.equal(context.isCurrent(), true);
  s.render({ session: session('B') });
  assert.equal(context.isCurrent(), false); assert.equal(context.signal.aborted, true);
  finish(false); await flushBackgroundAsync();
  assert.equal(s.render().error, ''); assert.equal(s.render().data, null);
  s.requests[1].resolve({ revision: 2, job: null }); await flushBackgroundAsync();
  assert.equal(s.render().data.revision, 2); s.unmount();
});
