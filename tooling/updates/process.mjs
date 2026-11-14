import { spawn } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';

const directories = new Map();
const normalized = directory => process.platform === 'win32' ? resolve(directory).toLowerCase() : resolve(directory);
const contains = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
};
function register(directory) {
  const path = normalized(directory), state = directories.get(path) || { active: 0, unsafe: false };
  directories.set(path, state); state.active++;
  return unsafe => { state.active--; state.unsafe ||= unsafe; if (!state.active && !state.unsafe) directories.delete(path); };
}
export function canCleanProcessDirectory(directory) {
  const path = normalized(directory);
  return ![...directories].some(([registered, state]) => (state.active || state.unsafe)
    && (contains(path, registered) || contains(registered, path)));
}
const failure = code => Object.assign(new Error(code), { code });
const validPid = pid => Number.isSafeInteger(pid) && pid > 0;
const taskkillPath = () => join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');

// One process-tree lifetime for both compilation and upload. A timed-out stop
// leaves a permanent unsafe mark: late events cannot authorize scratch removal.
export async function runManagedProcess(root, executable, args, environment, {
  signal, timeoutMs, failureCode, timeoutCode = failureCode, processDirectories = [],
  spawnImpl = spawn, killImpl = process.kill, platform = process.platform,
  graceMs = 2000, stopDeadlineMs = 10000,
} = {}) {
  const releases = [...new Set([root, ...processDirectories].map(normalized))].map(register);
  let unsafe = false;
  try {
    return await new Promise((accept, reject) => {
      let child, terminator, childClosed = false, stopping = false, settled = false, stoppedError = null;
      let commandTimer, deadlineTimer, graceTimer, pollTimer;
      let treeStopped = false, treeStopStarted = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(commandTimer); clearTimeout(deadlineTimer); clearTimeout(graceTimer); clearInterval(pollTimer);
        signal?.removeEventListener('abort', cancel);
        if (unsafe && error) error.cleanupUnsafe = true;
        error ? reject(error) : accept();
      };
      const stopped = () => { if (stopping && childClosed && treeStopped) finish(stoppedError); };
      const groupGone = () => {
        try { killImpl(-child.pid, 0); return false; }
        catch (error) { return error?.code === 'ESRCH'; }
      };
      const observeGroup = () => {
        if (!settled && !treeStopped && groupGone()) {
          treeStopped = true; clearTimeout(graceTimer); clearInterval(pollTimer); stopped();
        }
      };
      const deadline = Math.min(10000, Math.max(1, stopDeadlineMs));
      const stopTree = () => {
        if (treeStopStarted || settled || !validPid(child?.pid)) return;
        treeStopStarted = true;
        if (platform === 'win32') {
          try {
            terminator = spawnImpl(taskkillPath(), ['/PID', String(child.pid), '/T', '/F'], {
              shell: false, windowsHide: true, stdio: 'ignore',
            });
            terminator.on('error', () => { /* No proof of tree exit; wait for the fixed deadline. */ });
            terminator.once('close', code => { if (code === 0) treeStopped = true; stopped(); });
          } catch { /* No proof of tree exit; wait for the fixed deadline. */ }
        } else {
          try { killImpl(-child.pid, 'SIGTERM'); } catch { /* ESRCH is checked separately. */ }
          observeGroup();
          if (!settled && !treeStopped) {
            graceTimer = setTimeout(() => {
              try { killImpl(-child.pid, 'SIGKILL'); } catch { /* Continue observing the entire group. */ }
              observeGroup();
            }, Math.min(2000, Math.max(0, graceMs), deadline));
            pollTimer = setInterval(observeGroup, Math.min(20, Math.max(1, deadline / 4)));
          }
        }
      };
      const stop = error => {
        if (settled) return;
        stoppedError ||= error;
        if (stopping) return;
        stopping = true;
        clearTimeout(commandTimer);
        deadlineTimer = setTimeout(() => {
          unsafe = true;
          // taskkill is a fixed local utility, not another unbounded operation.
          try { terminator?.kill(); } catch { /* Preserve the first stop cause. */ }
          finish(stoppedError);
        }, deadline);
        // A missing PID alone is not a confirmed spawn failure. If spawn has
        // not reported yet, only its error event permits immediate rejection.
        stopTree();
      };
      const cancel = () => stop(failure('SYSTEM_UPDATE_LEASE_LOST'));
      if (signal?.aborted) { finish(failure('SYSTEM_UPDATE_LEASE_LOST')); return; }
      try {
        child = spawnImpl(executable, args, { cwd: root, env: environment, shell: false, windowsHide: true,
          stdio: 'ignore', detached: platform !== 'win32' });
      } catch { finish(failure(failureCode)); return; }
      child.on('error', () => {
        // Once there is a PID, an error event does not prove that the process
        // or descendants exited. Keep the first cause and stop the whole tree.
        if (!validPid(child.pid)) finish(stoppedError || failure(failureCode));
        else stop(failure(failureCode));
      });
      child.once('spawn', () => { if (stopping) stopTree(); });
      child.once('close', code => {
        childClosed = true;
        if (stopping) stopped();
        else if (code === 0) finish();
        else stop(failure(failureCode));
      });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      if (!stopping && !settled) commandTimer = setTimeout(() => stop(failure(timeoutCode)), timeoutMs);
    });
  } finally { for (const release of releases) release(unsafe); }
}
