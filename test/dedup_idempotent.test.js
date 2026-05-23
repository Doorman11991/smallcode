// Regression tests for per-turn idempotent-write dedup.
//
// Closes the gap where small models could spam memory_remember with the same
// args dozens of times in one turn (observed: 36 calls before the tool-call
// cap killed the run). Inspired by itsy commit 32653f3.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  IdempotentWriteSet,
  IDEMPOTENT_WRITE_TOOLS,
  idempotentWriteKey,
  getIdempotentWriteSet,
  resetIdempotentWriteSet,
  newTurnIdempotentWriteSet,
} = require('../src/tools/dedup');

test('memory_remember and memory_forget are flagged idempotent', () => {
  const set = new IdempotentWriteSet();
  assert.equal(set.isIdempotent('memory_remember'), true);
  assert.equal(set.isIdempotent('memory_forget'), true);
  assert.equal(set.isIdempotent('write_file'), false);
  assert.equal(set.isIdempotent('bash'), false);
});

test('IDEMPOTENT_WRITE_TOOLS export contains the right tools', () => {
  assert.ok(IDEMPOTENT_WRITE_TOOLS.has('memory_remember'));
  assert.ok(IDEMPOTENT_WRITE_TOOLS.has('memory_forget'));
  assert.ok(!IDEMPOTENT_WRITE_TOOLS.has('write_file'));
});

test('first call passes; second identical call is short-circuited', () => {
  const set = new IdempotentWriteSet();
  const args = { type: 'context', title: 'x', content: 'y' };
  assert.equal(set.has('memory_remember', args), false);
  set.record('memory_remember', args, { result: 'ok' });
  assert.equal(set.has('memory_remember', args), true);
});

test('different args do NOT collide', () => {
  const set = new IdempotentWriteSet();
  set.record('memory_remember', { type: 'a', title: '1' }, { result: 'ok' });
  assert.equal(set.has('memory_remember', { type: 'a', title: '1' }), true);
  assert.equal(set.has('memory_remember', { type: 'a', title: '2' }), false);
  assert.equal(set.has('memory_remember', { type: 'b', title: '1' }), false);
});

test('argument key order does NOT change the hash', () => {
  const k1 = idempotentWriteKey('memory_remember', { type: 'context', title: 'x' });
  const k2 = idempotentWriteKey('memory_remember', { title: 'x', type: 'context' });
  assert.equal(k1, k2);
});

test('non-idempotent tools are NOT recorded', () => {
  const set = new IdempotentWriteSet();
  set.record('write_file', { path: 'x.txt', content: 'y' }, { result: 'ok' });
  assert.equal(set.has('write_file', { path: 'x.txt', content: 'y' }), false);
});

test('errored calls are NOT recorded — model can retry', () => {
  const set = new IdempotentWriteSet();
  set.record('memory_remember', { title: 'x' }, { error: 'boom' });
  assert.equal(set.has('memory_remember', { title: 'x' }), false);
});

test('newTurn() clears the set', () => {
  const set = new IdempotentWriteSet();
  set.record('memory_remember', { title: 'x' }, { result: 'ok' });
  assert.equal(set.has('memory_remember', { title: 'x' }), true);
  set.newTurn();
  assert.equal(set.has('memory_remember', { title: 'x' }), false);
});

test('shortCircuitResult returns the canonical skipped marker', () => {
  const set = new IdempotentWriteSet();
  const r = set.shortCircuitResult('memory_remember');
  assert.match(r.result, /already stored this turn/);
  assert.equal(r._idempotentWriteSkipped, true);
  assert.equal(set.stats().hits, 1);
});

test('SMALLCODE_IDEMPOTENT_WRITE_DEDUP=false disables the set', () => {
  const prev = process.env.SMALLCODE_IDEMPOTENT_WRITE_DEDUP;
  process.env.SMALLCODE_IDEMPOTENT_WRITE_DEDUP = 'false';
  try {
    const set = new IdempotentWriteSet();
    set.record('memory_remember', { title: 'x' }, { result: 'ok' });
    assert.equal(set.has('memory_remember', { title: 'x' }), false);
  } finally {
    if (prev === undefined) delete process.env.SMALLCODE_IDEMPOTENT_WRITE_DEDUP;
    else process.env.SMALLCODE_IDEMPOTENT_WRITE_DEDUP = prev;
  }
});

test('singleton helpers reset/newTurn work', () => {
  const a = getIdempotentWriteSet();
  const b = getIdempotentWriteSet();
  assert.strictEqual(a, b);
  a.record('memory_remember', { title: 'q' }, { result: 'ok' });
  assert.equal(a.has('memory_remember', { title: 'q' }), true);
  newTurnIdempotentWriteSet();
  assert.equal(a.has('memory_remember', { title: 'q' }), false);
  resetIdempotentWriteSet();
});

// 36-call simulation — the actual observed pattern in itsy fix-git trial 1.
test('spam loop short-circuits after first call', () => {
  resetIdempotentWriteSet();
  const set = getIdempotentWriteSet();
  const args = { type: 'context', title: 'wedge', content: 'foo' };
  let executed = 0;
  for (let i = 0; i < 36; i++) {
    if (set.has('memory_remember', args)) continue;
    executed += 1;
    set.record('memory_remember', args, { result: 'ok' });
  }
  assert.equal(executed, 1, 'only the first call should run; the other 35 are short-circuited');
  resetIdempotentWriteSet();
});
