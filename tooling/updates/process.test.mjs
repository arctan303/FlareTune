import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runManagedProcess, canCleanProcessDirectory } from './process.mjs';
import { runBuildCommand, sanitizedBuildEnvironment } from './bootstrap.mjs';
import { uploadSystemVersion } from './deploy.mjs';

const pause = ms => new Promise(accept => setTimeout(accept, ms));
const failed = 'SYSTEM_UPDATE_BUILD_FAILED', lost = 'SYSTEM_UPDATE_LEASE_LOST';
function fakeChild(pid) { return Object.assign(new EventEmitter(), { pid, kill: () => false }); }
async function directory(t, { real = false } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-process-test-'));
  t.after(async () => {
    let absolute;
    try { absolute = await realpath(root); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    assert.equal(dirname(absolute), await realpath(tmpdir()));
    assert.ok(basename(absolute).startsWith('flaretune-process-test-'));
    if (real && !canCleanProcessDirectory(absolute)) return;
    // Synthetic unsafe tests have no OS processes; their fixture teardown is
    // deliberately independent of the application's persistent unsafe fence.
    await rm(absolute, { recursive: true, force: true });
  });
  return root;
}
const options = extra => ({ timeoutMs: 1000, failureCode: failed, graceMs: 10, stopDeadlineMs: 100, ...extra });

test('a no-PID spawn error rejects promptly without a fictitious close or unsafe scratch', async t => {
  const root = await directory(t), child = fakeChild();
  const pending = runManagedProcess(root, 'synthetic', [], {}, options({ spawnImpl: () => child }));
  assert.equal(canCleanProcessDirectory(root), false);
  child.emit('error', Error('synthetic spawn failure'));
  await assert.rejects(pending, error => error.code === failed && error.cleanupUnsafe !== true);
  assert.equal(canCleanProcessDirectory(root), true);
});

test('a missing PID without a confirmed spawn error remains unsafe at the bounded stop deadline', async t => {
  const root = await directory(t), child = fakeChild(), abort = new AbortController();
  const pending = runManagedProcess(root, 'synthetic', [], {}, options({ signal: abort.signal, spawnImpl: () => child, stopDeadlineMs: 25 }));
  abort.abort();
  await assert.rejects(pending, error => error.code === lost && error.cleanupUnsafe === true);
  child.emit('close', 0);
  assert.equal(canCleanProcessDirectory(root), false);
});

test('Windows waits for taskkill and child close and preserves whichever stop cause arrived first', async t => {
  for (const first of ['error', 'abort']) {
    const root = await directory(t), output = resolve(root, 'output'), child = fakeChild(12345), terminator = fakeChild(54321);
    const abort = new AbortController(); let completed = false, terminations = 0;
    const pending = runManagedProcess(root, 'synthetic', [], {}, options({ platform: 'win32', signal: abort.signal,
      processDirectories: [output], spawnImpl: (command, args, config) => {
        if (command === 'synthetic') return child;
        terminations++;
        assert.match(command, /[\\/]System32[\\/]taskkill\.exe$/i);
        assert.deepEqual(args, ['/PID', '12345', '/T', '/F']);
        assert.equal(config.shell, false); assert.equal(config.windowsHide, true);
        return terminator;
      } }));
    const result = pending.catch(error => { completed = true; return error; });
    if (first === 'error') { child.emit('error', Error('synthetic late process error')); abort.abort(); }
    else { abort.abort(); child.emit('error', Error('synthetic late process error')); }
    terminator.emit('close', 0);
    await pause(5);
    assert.equal(completed, false); assert.equal(canCleanProcessDirectory(root), false);
    assert.equal(canCleanProcessDirectory(output), false);
    child.emit('close', 1);
    const error = await result;
    assert.equal(error.code, first === 'error' ? failed : lost);
    assert.equal(error.cleanupUnsafe, undefined);
    assert.equal(terminations, 1);
    assert.equal(canCleanProcessDirectory(root), true);
  }
});

test('POSIX parent close does not finish a stop while a descendant group survives TERM', async t => {
  const root = await directory(t), child = fakeChild(12345), abort = new AbortController();
  let groupAlive = true, killed = false, completed = false;
  const pending = runManagedProcess(root, 'synthetic', [], {}, options({ platform: 'linux', signal: abort.signal,
    spawnImpl: (_command, _args, config) => { assert.equal(config.detached, true); return child; },
    killImpl: (pid, signal) => {
      assert.equal(pid, -12345);
      if (signal === 'SIGKILL') { killed = true; groupAlive = false; }
      if (!groupAlive) throw Object.assign(Error('gone'), { code: 'ESRCH' });
      return true;
    }, graceMs: 30, stopDeadlineMs: 150 }));
  const result = pending.catch(error => { completed = true; return error; });
  abort.abort(); child.emit('close', null);
  await pause(5);
  assert.equal(completed, false); assert.equal(killed, false); assert.equal(canCleanProcessDirectory(root), false);
  const error = await result;
  assert.equal(error.code, lost); assert.equal(error.cleanupUnsafe, undefined); assert.equal(killed, true);
  assert.equal(canCleanProcessDirectory(root), true);
});

test('kill false and late close never clear an unsafe deadline or replace the first abort cause', async t => {
  const root = await directory(t), output = await directory(t), child = fakeChild(12345), abort = new AbortController();
  let terminations = 0;
  const pending = runManagedProcess(root, 'synthetic', [], {}, options({ platform: 'linux', signal: abort.signal,
    processDirectories: [output], spawnImpl: () => child, killImpl: (_pid, signal) => { if (signal) terminations++; return false; },
    graceMs: 5, stopDeadlineMs: 30 }));
  const result = pending.catch(error => error);
  abort.abort(); child.emit('error', Error('late error')); child.emit('close', 0);
  const error = await result;
  assert.equal(error.code, lost); assert.equal(error.cleanupUnsafe, true); assert.ok(terminations >= 2);
  assert.equal(canCleanProcessDirectory(root), false); assert.equal(canCleanProcessDirectory(output), false);
  child.emit('close', 0);
  await pause(10);
  assert.equal(canCleanProcessDirectory(root), false);
});

test('a confirmed absent POSIX group is not signalled again while waiting for the parent close event', async t => {
  const root = await directory(t), child = fakeChild(12345), abort = new AbortController(), signals = [];
  const pending = runManagedProcess(root, 'synthetic', [], {}, options({ platform: 'linux', signal: abort.signal,
    spawnImpl: () => child, killImpl: (_pid, signal) => {
      if (signal === 0) throw Object.assign(Error('gone'), { code: 'ESRCH' });
      signals.push(signal); return true;
    } }));
  const result = pending.catch(error => error);
  abort.abort();
  await pause(30);
  assert.equal(canCleanProcessDirectory(root), false);
  assert.deepEqual(signals, ['SIGTERM']);
  child.emit('close', 1);
  assert.equal((await result).code, lost); assert.equal(canCleanProcessDirectory(root), true);
});

test('a failed Windows taskkill cannot authorize cleanup even after the direct child closes', async t => {
  const root = await directory(t), child = fakeChild(12345), terminator = fakeChild(54321), abort = new AbortController();
  const pending = runManagedProcess(root, 'synthetic', [], {}, options({ platform: 'win32', signal: abort.signal,
    spawnImpl: command => command === 'synthetic' ? child : terminator, stopDeadlineMs: 25 }));
  const result = pending.catch(error => error);
  abort.abort(); child.emit('close', 0); terminator.emit('close', 1);
  const error = await result;
  assert.equal(error.code, lost); assert.equal(error.cleanupUnsafe, true);
  assert.equal(canCleanProcessDirectory(root), false);
});

test('upload retains its output scratch when a tree stop cannot be confirmed', async t => {
  const root = await directory(t), abort = new AbortController(), child = fakeChild(12345);
  let output;
  const pending = uploadSystemVersion({ workerName: 'synthetic-worker', accountId: 'a'.repeat(32), token: 'synthetic-token' },
    { taskId: 'synthetic-task' }, { root, configPath: resolve(root, 'synthetic-config.json'), signal: abort.signal,
      runProcessImpl: (cwd, command, args, environment, input) => {
        output = dirname(environment.WRANGLER_OUTPUT_FILE_PATH);
        return runManagedProcess(cwd, command, args, environment, { ...input, spawnImpl: () => child,
          platform: 'linux', killImpl: () => false, graceMs: 5, stopDeadlineMs: 25 });
      } });
  const result = pending.catch(error => error);
  while (!output) await pause(1);
  abort.abort(); child.emit('close', 1);
  const error = await result;
  assert.equal(error.code, lost); assert.equal(error.cleanupUnsafe, true);
  assert.equal((await stat(output)).isDirectory(), true);
  assert.equal(canCleanProcessDirectory(output), false);
  assert.equal(canCleanProcessDirectory(root), false);
  const absolute = await realpath(output);
  assert.equal(dirname(absolute), await realpath(tmpdir())); assert.ok(basename(absolute).startsWith('flaretune-system-upload-'));
  await rm(absolute, { recursive: true, force: true }); // No real process was created in this synthetic fixture.
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function waitUntil(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(20); }
  assert.fail('Synthetic process fixture did not become ready');
}
function treeProgram(root, { upload = false, ignoreTerm = false } = {}) {
  const marker = resolve(root, 'descendant-marker'), pids = resolve(root, 'tree-pids.json');
  const descendant = `const fs=require('node:fs');${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}
    setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),10);`;
  return { marker, pids, code: `const fs=require('node:fs');const{spawn}=require('node:child_process');
    ${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}
    const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true,shell:false});
    fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify({parent:process.pid,child:child.pid${upload ? ",output:process.env.WRANGLER_OUTPUT_FILE_PATH" : ''}}));
    setInterval(()=>{},1000);` };
}
async function realTree(t, { upload = false, ignoreTerm = false } = {}) {
  const root = await directory(t, { real: true }), abort = new AbortController(), fixture = treeProgram(root, { upload, ignoreTerm });
  let pids;
  t.after(() => {
    if (process.platform === 'win32' && pids) {
      const taskkill = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe');
      for (const pid of [pids.parent, pids.child]) if (alive(pid)) spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', timeout: 1000 });
    } else if (pids && alive(pids.parent)) { try { process.kill(-pids.parent, 'SIGKILL'); } catch {} }
  });
  if (upload) {
    await mkdir(resolve(root, 'node_modules/wrangler/bin'), { recursive: true });
    await writeFile(resolve(root, 'node_modules/wrangler/bin/wrangler.js'), fixture.code);
  }
  const pending = upload
    ? uploadSystemVersion({ workerName: 'synthetic-worker', accountId: 'a'.repeat(32), token: 'synthetic-token' }, { taskId: 'synthetic-task' },
      { root, configPath: resolve(root, 'synthetic-config.json'), environment: process.env, signal: abort.signal })
    : runBuildCommand(root, 'node', ['-e', fixture.code], sanitizedBuildEnvironment(process.env, 'e'.repeat(40)), { signal: abort.signal });
  const result = pending.catch(error => error);
  await waitUntil(async () => {
    try { pids = JSON.parse(await readFile(fixture.pids, 'utf8')); return (await stat(fixture.marker)).size > 3; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  assert.equal(canCleanProcessDirectory(root), false); assert.equal(alive(pids.parent), true); assert.equal(alive(pids.child), true);
  abort.abort();
  const error = await result;
  assert.equal(error.code, lost); assert.equal(error.cleanupUnsafe, undefined);
  assert.equal(alive(pids.parent), false); assert.equal(alive(pids.child), false);
  const size = (await stat(fixture.marker)).size;
  await pause(80); assert.equal((await stat(fixture.marker)).size, size);
  assert.equal(canCleanProcessDirectory(root), true);
  if (upload) await assert.rejects(stat(dirname(pids.output)), { code: 'ENOENT' });
  const absolute = await realpath(root);
  assert.equal(dirname(absolute), await realpath(tmpdir())); assert.ok(basename(absolute).startsWith('flaretune-process-test-'));
  await rm(absolute, { recursive: true, force: true });
  await assert.rejects(stat(root), { code: 'ENOENT' });
}

test('Windows actual build abort stops the working descendant before its directory can be removed', { skip: process.platform !== 'win32', timeout: 20000 }, async t => realTree(t));
test('Windows actual upload abort stops the working descendant before removing output scratch', { skip: process.platform !== 'win32', timeout: 20000 }, async t => realTree(t, { upload: true }));
test('Linux actual detached descendants ignoring TERM are killed before cleanup', { skip: process.platform !== 'linux', timeout: 20000 }, async t => realTree(t, { ignoreTerm: true }));
