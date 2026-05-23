// SmallCode — Contract tool dispatch
//
// Splits the contract-related tool branches out of bin/executor.js so the
// executor stays under the 600-line guideline. One entry point:
// `executeContractTool(name, args, { cwd })`.

'use strict';

const { getStore, STATES, STATUSES } = require('./contract_store');

// Build the standard "contract status" payload — used by contract_status
// directly and appended to every other contract-tool response so the model
// always sees current state without a follow-up call.

function statusPayload(store) {
  const c = store.active();
  if (!c) {
    const all = store.list();
    if (all.length === 0) {
      return {
        active: null,
        contracts: [],
        message: 'No contracts on disk. Use contract_create to declare a Definition of Done.',
      };
    }
    return {
      active: null,
      contracts: all.map((row) => ({ id: row.id, title: row.title, status: row.status })),
      message: 'No active contract. Use /contract activate <id> to set one.',
    };
  }
  const ds = c.doneStatus();
  return {
    active: c.id,
    title: c.title,
    status: c.status,
    summary: `${ds.passed}/${ds.total} passed (${ds.failed} failed, ${ds.pending} pending, ${ds.skipped} skipped)`,
    done: ds.done,
    assertions: c.assertions.map((a) => ({ id: a.id, text: a.text, state: a.state })),
    blockers: ds.blockers,
  };
}

function formatStatus(payload) {
  if (!payload.active) {
    if (payload.contracts && payload.contracts.length > 0) {
      const list = payload.contracts.map((c) => `  - ${c.id}  [${c.status}]  ${c.title}`).join('\n');
      return `${payload.message}\n${list}`;
    }
    return payload.message;
  }
  const lines = [];
  lines.push(`Contract: ${payload.title}  (${payload.active})`);
  lines.push(`Status: ${payload.status}  —  ${payload.summary}`);
  lines.push('');
  for (const a of payload.assertions) {
    const mark = a.state === STATES.PASSED ? '[PASS]'
      : a.state === STATES.FAILED ? '[FAIL]'
      : a.state === STATES.SKIPPED ? '[SKIP]'
      : '[    ]';
    lines.push(`  ${mark} ${a.id}  ${a.text}`);
  }
  if (payload.blockers && payload.blockers.length > 0) {
    lines.push('');
    lines.push(`Blockers: ${payload.blockers.map((b) => b.id).join(', ')}`);
  } else if (payload.done) {
    lines.push('');
    lines.push('All assertions resolved — done-guard will allow final response.');
  }
  return lines.join('\n');
}

// ─── tool branches ───────────────────────────────────────────────────────────

async function executeContractTool(name, args, ctx) {
  const store = getStore(ctx.cwd || process.cwd());

  switch (name) {
    case 'contract_status': {
      const payload = statusPayload(store);
      return { result: formatStatus(payload), payload };
    }

    case 'contract_create': {
      const title = String(args.title || '').trim() || 'Untitled contract';
      const brief = String(args.brief || '').trim();
      const assertions = args.assertions;
      if (!assertions || (Array.isArray(assertions) && assertions.length === 0)) {
        return { error: 'contract_create requires at least one assertion (array of strings).' };
      }
      const c = store.create({ title, brief, assertions });
      store.activate(c.id);
      const payload = statusPayload(store);
      return {
        result: `Created and activated contract ${c.id} with ${c.assertions.length} assertions.\n\n${formatStatus(payload)}`,
        contract_id: c.id,
        payload,
      };
    }

    case 'contract_assert_pass':
    case 'contract_assert_fail':
    case 'contract_assert_skip': {
      const aid = String(args.assertion_id || '').trim();
      if (!aid) return { error: `${name}: assertion_id is required.` };

      const state = name === 'contract_assert_pass' ? STATES.PASSED
        : name === 'contract_assert_fail' ? STATES.FAILED
        : STATES.SKIPPED;

      const evidence = args.evidence || args.reason || '';
      const lastCheck = (args.command || args.exit_code !== undefined)
        ? {
            command: String(args.command || ''),
            exit_code: Number.isFinite(args.exit_code) ? args.exit_code : 0,
            observation: String(args.evidence || args.reason || '').slice(0, 200),
            timestamp: new Date().toISOString(),
          }
        : null;

      let updated;
      try {
        updated = store.markAssertion(aid, state, { evidence, lastCheck });
      } catch (e) {
        return { error: `${name}: ${e.message}` };
      }

      const payload = statusPayload(store);
      const verb = state === STATES.PASSED ? 'passed'
        : state === STATES.FAILED ? 'failed'
        : 'skipped';
      return {
        result: `Marked ${aid} as ${verb}. ${payload.summary}${updated.status === STATUSES.COMPLETED ? ' — contract complete.' : ''}`,
        payload,
      };
    }

    default:
      return { error: `unknown contract tool: ${name}` };
  }
}

module.exports = { executeContractTool, statusPayload, formatStatus };
