import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeXiaoaContext,
  normalizeXiaoaToolProgress,
} from './assistantClientTools.js';

test('tool progress is optional, flattened, and bounded before rendering', () => {
  assert.equal(normalizeXiaoaToolProgress(undefined), '');
  assert.equal(normalizeXiaoaToolProgress('  我去\n曲库里找一下。  '), '我去 曲库里找一下。');
  assert.equal(Array.from(normalizeXiaoaToolProgress('字'.repeat(150))).length, 100);
});

test('request context is normalized before sending', () => {
  const context = normalizeXiaoaContext({ location: 'x'.repeat(600), pageContext: 'y'.repeat(1800) });
  assert.equal(context.location.length, 500);
  assert.equal(context.pageContext.length, 1500);
  assert.equal(context.playerActionReceipts, undefined);
});

test('player action receipts keep only the server contract shape and the latest ten entries', () => {
  const receipts = Array.from({ length: 12 }, (unused, index) => ({
    id: `call-${index}`,
    ok: index % 2 === 0,
    outcome: 'applied',
  }));
  receipts.push({ id: '', ok: true });
  receipts.push({ id: 'no-ok', outcome: 'applied' });
  receipts.push({ id: 'too-long', ok: true, outcome: 'o'.repeat(400) });
  receipts.push('not-an-object');

  const context = normalizeXiaoaContext({ playerActionReceipts: receipts });

  assert.equal(context.playerActionReceipts.length, 10);
  assert.equal(context.playerActionReceipts[0].id, 'call-0');
  assert.equal(context.playerActionReceipts[9].id, 'call-9');
  assert.equal(context.playerActionReceipts[0].ok, true);
  assert.equal(context.playerActionReceipts[1].ok, false);

  const trimmed = normalizeXiaoaContext({
    playerActionReceipts: [{ id: '  spaced  ', ok: false, outcome: '  o'.repeat(200) }],
  });
  assert.equal(trimmed.playerActionReceipts[0].id, 'spaced');
  assert.equal(trimmed.playerActionReceipts[0].outcome.length, 300);
});
