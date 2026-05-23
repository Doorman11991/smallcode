// E2E tests for the Contract / Definition-of-Done feature.
//
// Covers:
//   - state model (Contract class invariants)
//   - file-backed store (create / save / load / activate / list)
//   - tool dispatch (contract_create, contract_assert_pass/fail/skip, contract_status)
//   - done-guard (looksLikeDoneClaim and checkDoneGuard)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  Contract,
  STATES,
  STATUSES,
  parseAssertions,
  newAssertionId,
} = require('../src/session/contract');

const { ContractStore, getStore, resetStore } = require('../src/session/contract_store');
const { executeContractTool, statusPayload, formatStatus } = require('../src/session/contract_tools');
const { checkDoneGuard, looksLikeDoneClaim } = require('../src/session/contract_guard');

// ─── helpers ────────────────────────────────────────────────────────────────

function freshTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-contract-'));
  // The store reads .smallcode/contracts under cwd. Each test uses a fresh dir.
  return dir;
}

// ─── state model ────────────────────────────────────────────────────────────

test('parseAssertions handles markdown bullets and numbered lists', () => {
  const a1 = parseAssertions('- foo\n- bar\n* baz\n  \n');
  assert.equal(a1.length, 3);
  assert.equal(a1[0].text, 'foo');
  assert.equal(a1[2].text, 'baz');

  const a2 = parseAssertions('1. one\n2) two\n3. three\n');
  assert.equal(a2.length, 3);
  assert.equal(a2[1].text, 'two');

  const a3 = parseAssertions(['x', '', 'y']);
  assert.equal(a3.length, 2);
});

test('parseAssertions returns empty array on empty input', () => {
  assert.equal(parseAssertions('').length, 0);
  assert.equal(parseAssertions(null).length, 0);
  assert.equal(parseAssertions('   \n   ').length, 0);
});

test('Contract.isDone() requires every assertion resolved', () => {
  const c = new Contract({
    id: newAssertionId(0),
    title: 't',
    assertions: [
      { id: 'a01', text: 'x', state: STATES.PENDING },
      { id: 'a02', text: 'y', state: STATES.PASSED },
    ],
  });
  assert.equal(c.isDone(), false);
  c.setAssertionState('a01', STATES.PASSED);
  assert.equal(c.isDone(), true);
});

test('Contract.isDone() — skipped counts as resolved, failed does not', () => {
  const c = new Contract({
    id: 'x',
    title: 't',
    assertions: [
      { id: 'a01', text: 'x', state: STATES.SKIPPED },
      { id: 'a02', text: 'y', state: STATES.PASSED },
    ],
  });
  assert.equal(c.isDone(), true);
  c.setAssertionState('a02', STATES.FAILED);
  assert.equal(c.isDone(), false);
});

test('Contract.setAssertionState rejects invalid state', () => {
  const c = new Contract({ id: 'x', title: 't', assertions: [{ id: 'a01', text: 'x', state: STATES.PENDING }] });
  assert.throws(() => c.setAssertionState('a01', 'made-up'), /invalid assertion state/);
  assert.throws(() => c.setAssertionState('missing', STATES.PASSED), /assertion not found/);
});

// ─── store ──────────────────────────────────────────────────────────────────

test('ContractStore.create persists and activates a contract', () => {
  const cwd = freshTmpRoot();
  resetStore();
  const store = new ContractStore(cwd);
  const draft = store.create({ title: 'T', brief: 'B', assertions: ['one', 'two'] });
  store.activate(draft.id);
  const c = store.get(draft.id); // re-read after activation flips status

  assert.equal(c.assertions.length, 2);
  assert.equal(c.status, STATUSES.ACTIVE); // activate flips DRAFT → ACTIVE
  assert.equal(store.activeId(), c.id);
  // Files were written
  assert.ok(fs.existsSync(path.join(cwd, '.smallcode', 'contracts', c.id, 'state.json')));
  assert.ok(fs.existsSync(path.join(cwd, '.smallcode', 'contracts', c.id, 'contract.md')));
  assert.ok(fs.existsSync(path.join(cwd, '.smallcode', 'contracts', c.id, 'assertions.md')));
});

test('ContractStore.create rejects empty assertion list', () => {
  const cwd = freshTmpRoot();
  const store = new ContractStore(cwd);
  assert.throws(() => store.create({ title: 'x', brief: '', assertions: [] }), /at least one/);
});

test('ContractStore round-trips state.json correctly', () => {
  const cwd = freshTmpRoot();
  const store = new ContractStore(cwd);
  const c = store.create({ title: 'roundtrip', brief: '', assertions: ['a', 'b'] });
  store.activate(c.id);
  store.markAssertion('a01', STATES.PASSED, { evidence: 'cargo test passed', lastCheck: { command: 'cargo test', exit_code: 0, observation: 'ok', timestamp: 'now' } });

  // New store instance, same cwd: should see the persisted state
  const fresh = new ContractStore(cwd);
  const reloaded = fresh.get(c.id);
  assert.equal(reloaded.assertions[0].state, STATES.PASSED);
  assert.equal(reloaded.assertions[0].evidence, 'cargo test passed');
  assert.equal(reloaded.assertions[1].state, STATES.PENDING);
});

test('ContractStore.markAssertion auto-completes when all resolved', () => {
  const cwd = freshTmpRoot();
  const store = new ContractStore(cwd);
  const c = store.create({ title: 'auto', brief: '', assertions: ['a', 'b'] });
  store.activate(c.id);
  store.markAssertion('a01', STATES.PASSED);
  let now = store.get(c.id);
  assert.equal(now.status, STATUSES.ACTIVE);
  store.markAssertion('a02', STATES.PASSED);
  now = store.get(c.id);
  assert.equal(now.status, STATUSES.COMPLETED);
});

test('ContractStore.complete refuses while blockers remain', () => {
  const cwd = freshTmpRoot();
  const store = new ContractStore(cwd);
  const c = store.create({ title: 't', brief: '', assertions: ['x', 'y'] });
  store.activate(c.id);
  store.markAssertion('a01', STATES.PASSED);
  assert.throws(() => store.complete(), /pending|failed|cannot complete/i);
});

test('ContractStore.list sorts by ID and reports doneStatus', () => {
  const cwd = freshTmpRoot();
  const store = new ContractStore(cwd);
  store.create({ title: 'A', brief: '', assertions: ['x'] });
  store.create({ title: 'B', brief: '', assertions: ['y', 'z'] });
  const list = store.list();
  assert.equal(list.length, 2);
  for (const row of list) {
    assert.ok(row.doneStatus);
    assert.equal(typeof row.doneStatus.total, 'number');
  }
});

test('ContractStore log.jsonl appends events', () => {
  const cwd = freshTmpRoot();
  const store = new ContractStore(cwd);
  const c = store.create({ title: 'log', brief: '', assertions: ['x'] });
  store.activate(c.id);
  store.markAssertion('a01', STATES.PASSED, { evidence: 'ok' });
  const log = fs.readFileSync(path.join(cwd, '.smallcode', 'contracts', c.id, 'log.jsonl'), 'utf-8');
  const entries = log.trim().split('\n').map(JSON.parse);
  // create + activate + mark + auto_complete = 4 entries
  assert.ok(entries.length >= 3);
  assert.equal(entries[0].event, 'create');
});

// ─── tool dispatch ──────────────────────────────────────────────────────────

test('contract_create tool creates and activates a contract', async () => {
  const cwd = freshTmpRoot();
  resetStore();
  const r = await executeContractTool('contract_create', {
    title: 'feature X',
    brief: 'add the new endpoint',
    assertions: ['route is registered', 'handler returns 201', 'tests pass'],
  }, { cwd });
  assert.ok(r.contract_id);
  assert.match(r.result, /Created and activated/);
  assert.equal(r.payload.assertions.length, 3);
});

test('contract_create rejects empty assertions array', async () => {
  const cwd = freshTmpRoot();
  resetStore();
  const r = await executeContractTool('contract_create', { title: 't', assertions: [] }, { cwd });
  assert.ok(r.error);
});

test('contract_assert_pass marks an assertion and returns updated status', async () => {
  const cwd = freshTmpRoot();
  resetStore();
  await executeContractTool('contract_create', { title: 'x', assertions: ['one', 'two'] }, { cwd });
  const r = await executeContractTool('contract_assert_pass', {
    assertion_id: 'a01',
    evidence: 'ran cargo test, exit 0',
    command: 'cargo test',
    exit_code: 0,
  }, { cwd });
  assert.match(r.result, /Marked a01 as passed/);
  assert.equal(r.payload.assertions[0].state, STATES.PASSED);
});

test('contract_assert_fail records failure with evidence', async () => {
  const cwd = freshTmpRoot();
  resetStore();
  await executeContractTool('contract_create', { title: 'x', assertions: ['one'] }, { cwd });
  const r = await executeContractTool('contract_assert_fail', {
    assertion_id: 'a01',
    evidence: 'tests failed: 2 errors',
  }, { cwd });
  assert.match(r.result, /failed/);
  assert.equal(r.payload.assertions[0].state, STATES.FAILED);
});

test('contract_assert_skip skips an assertion', async () => {
  const cwd = freshTmpRoot();
  resetStore();
  await executeContractTool('contract_create', { title: 'x', assertions: ['one', 'two'] }, { cwd });
  const r = await executeContractTool('contract_assert_skip', {
    assertion_id: 'a02',
    reason: 'out of scope this PR',
  }, { cwd });
  assert.match(r.result, /skipped/);
  assert.equal(r.payload.assertions[1].state, STATES.SKIPPED);
});

test('contract_status with no contracts returns explanatory message', async () => {
  const cwd = freshTmpRoot();
  resetStore();
  const r = await executeContractTool('contract_status', {}, { cwd });
  assert.match(r.result, /No contracts/);
});

test('formatStatus renders a contract overview', () => {
  const fakePayload = {
    active: 'abc',
    title: 'feature X',
    status: 'active',
    summary: '1/2 passed',
    done: false,
    assertions: [
      { id: 'a01', text: 'one', state: STATES.PASSED },
      { id: 'a02', text: 'two', state: STATES.PENDING },
    ],
    blockers: [{ id: 'a02', text: 'two', state: STATES.PENDING }],
  };
  const out = formatStatus(fakePayload);
  assert.match(out, /Contract: feature X/);
  assert.match(out, /\[PASS\] a01/);
  assert.match(out, /Blockers: a02/);
});

// ─── done-guard ─────────────────────────────────────────────────────────────

test('looksLikeDoneClaim recognises wrap-up phrasing', () => {
  assert.equal(looksLikeDoneClaim('All done.'), true);
  assert.equal(looksLikeDoneClaim('The task is now complete.'), true);
  assert.equal(looksLikeDoneClaim('Successfully implemented the feature.'), true);
  assert.equal(looksLikeDoneClaim('Ready to ship.'), true);
  assert.equal(looksLikeDoneClaim('Should I proceed?'), false);
  assert.equal(looksLikeDoneClaim('Reading file utils.py'), false);
  assert.equal(looksLikeDoneClaim(''), false);
  assert.equal(looksLikeDoneClaim(null), false);
});

test('checkDoneGuard fires only when active contract has blockers', async () => {
  const cwd = freshTmpRoot();
  resetStore();
  // No contract yet — guard should be silent
  assert.equal(checkDoneGuard('All done.', cwd), null);

  await executeContractTool('contract_create', { title: 't', assertions: ['x', 'y'] }, { cwd });
  // Now there's an active contract with 2 pending blockers
  const guard = checkDoneGuard('All done — task is complete.', cwd);
  assert.ok(guard, 'guard should fire on a done claim with pending blockers');
  assert.match(guard.injection, /CONTRACT-GUARD/);
  assert.equal(guard.blockers.length, 2);

  // After resolving them, the guard should pass
  await executeContractTool('contract_assert_pass', { assertion_id: 'a01' }, { cwd });
  await executeContractTool('contract_assert_pass', { assertion_id: 'a02' }, { cwd });
  assert.equal(checkDoneGuard('All done.', cwd), null);
});

test('checkDoneGuard ignores non-completion text', async () => {
  const cwd = freshTmpRoot();
  resetStore();
  await executeContractTool('contract_create', { title: 't', assertions: ['x'] }, { cwd });
  assert.equal(checkDoneGuard('Reading the file now.', cwd), null);
  assert.equal(checkDoneGuard('What should the API return on 404?', cwd), null);
});

test('checkDoneGuard respects SMALLCODE_CONTRACT=false', async () => {
  const cwd = freshTmpRoot();
  resetStore();
  await executeContractTool('contract_create', { title: 't', assertions: ['x'] }, { cwd });
  const prev = process.env.SMALLCODE_CONTRACT;
  process.env.SMALLCODE_CONTRACT = 'false';
  try {
    assert.equal(checkDoneGuard('All done.', cwd), null);
  } finally {
    if (prev === undefined) delete process.env.SMALLCODE_CONTRACT;
    else process.env.SMALLCODE_CONTRACT = prev;
  }
});
