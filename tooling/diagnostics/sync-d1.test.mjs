import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { syncLocalD1 } from './sync-d1.mjs';

test('local replacement refuses implicit execution without touching files or D1', () => {
  const untouched = () => assert.fail('must not perform replacement');
  assert.equal(syncLocalD1({ io: { readFileSync: untouched, writeFileSync: untouched },
    execute: untouched, logger: { error() {} } }), 1);
});

test('Wrangler errors produce failure and never a success completion message', () => {
  for (const shouldFail of [true, false]) {
    const messages = [];
    const writes = [];
    const result = syncLocalD1({ confirmReplace: true,
      io: { readFileSync: () => 'CREATE TABLE test (id INTEGER);', writeFileSync: (file, sql) => writes.push(sql) },
      execute: (command, args, options) => {
        assert.equal(args.includes('--local'), true);
        assert.equal(args.includes('--remote'), false);
        assert.equal(args[args.indexOf('--persist-to') + 1], resolve('worker/.wrangler/state'));
        assert.equal(options.cwd, resolve('server'));
        if (shouldFail) throw new Error('simulated Wrangler failure');
      }, logger: { log: (...args) => messages.push(args.join(' ')), error: (...args) => messages.push(args.join(' ')) },
    });
    assert.match(writes[0], /DROP TABLE IF EXISTS test/);
    assert.equal(result, shouldFail ? 1 : 0);
    assert.equal(messages.includes('3. Sync complete!'), !shouldFail);
  }
});
