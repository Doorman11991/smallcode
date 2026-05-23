// SmallCode — Contract (Definition of Done)
//
// Compiled hand-port of marrow/contract.marrow.
//
// A contract is a list of testable **assertions** the model commits to up-front.
// The agent works through them, marking each `passed` or `failed` with command-
// line evidence. The model cannot deliver a final "I'm done" message while any
// assertion is still `pending` — there's a guard in bin/smallcode.js that
// refuses such final responses (see done_guard below).
//
// Layout on disk (per project, per contract):
//
//   .smallcode/contracts/
//     .active                <contract-id> the agent is currently working on
//     <contract-id>/
//       contract.md          proposal / brief (human-readable)
//       assertions.md        rendered assertion list (human-readable)
//       state.json           canonical machine-readable state (source of truth)
//       log.jsonl            append-only event log
//
// `state.json` is authoritative; `.md` files are re-rendered on each write so
// human readers see current state without needing a separate viewer.
//
// Inspired by itsy's `crates/itsy/src/session/contract.rs` (Rust). This is the
// JS implementation tuned for SmallCode's model loop.
//
// Configuration:
//   SMALLCODE_CONTRACT=false           disable the guard entirely (still allows /contract commands)
//   SMALLCODE_CONTRACT_DIR=<path>      override .smallcode/contracts location

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Constants ───────────────────────────────────────────────────────────────

const STATES = Object.freeze({
  PENDING: 'pending',
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

const STATUSES = Object.freeze({
  DRAFT: 'draft',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
});

const FILE_MODE = 0o600;

// ─── Paths ───────────────────────────────────────────────────────────────────

function contractsDir(cwd) {
  if (process.env.SMALLCODE_CONTRACT_DIR) return process.env.SMALLCODE_CONTRACT_DIR;
  return path.join(cwd || process.cwd(), '.smallcode', 'contracts');
}

function activeFile(cwd) { return path.join(contractsDir(cwd), '.active'); }
function contractDir(id, cwd) { return path.join(contractsDir(cwd), id); }
function statePath(id, cwd) { return path.join(contractDir(id, cwd), 'state.json'); }
function logPath(id, cwd) { return path.join(contractDir(id, cwd), 'log.jsonl'); }

// ─── ID generation ───────────────────────────────────────────────────────────
//
// Time-descending IDs so most-recent sorts first lexicographically. Same scheme
// as session/persistence.js.

function newContractId() {
  const t = (Number.MAX_SAFE_INTEGER - Date.now()).toString(36);
  const r = crypto.randomBytes(3).toString('hex');
  return `${t}-${r}`;
}

function newAssertionId(index) {
  return `a${String(index + 1).padStart(2, '0')}`;
}

// ─── Atomic writes ───────────────────────────────────────────────────────────

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, content, { mode: FILE_MODE });
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', { mode: FILE_MODE });
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderContractMd(contract) {
  const lines = [];
  lines.push(`# ${contract.title}`);
  lines.push('');
  lines.push(`- **id**: \`${contract.id}\``);
  lines.push(`- **status**: ${contract.status}`);
  lines.push(`- **created**: ${contract.created_at}`);
  lines.push('');
  if (contract.brief && contract.brief.trim()) {
    lines.push('## Brief');
    lines.push('');
    lines.push(contract.brief.trim());
    lines.push('');
  }
  return lines.join('\n');
}

function renderAssertionsMd(contract) {
  const lines = [];
  lines.push(`# Assertions for ${contract.title}`);
  lines.push('');
  if (contract.assertions.length === 0) {
    lines.push('_No assertions yet._');
    lines.push('');
    return lines.join('\n');
  }
  for (const a of contract.assertions) {
    const mark = a.state === STATES.PASSED ? '✅'
      : a.state === STATES.FAILED ? '❌'
      : a.state === STATES.SKIPPED ? '⊘'
      : '⏳';
    lines.push(`- ${mark} **${a.id}** — ${a.text} _(${a.state})_`);
    if (a.evidence) {
      const trimmed = a.evidence.length > 240 ? a.evidence.slice(0, 240) + '…' : a.evidence;
      lines.push(`    > ${trimmed.replace(/\n/g, '\n    > ')}`);
    }
    if (a.last_check && a.last_check.command) {
      lines.push(`    > _last check: \`${a.last_check.command}\` (exit ${a.last_check.exit_code})_`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Core model ──────────────────────────────────────────────────────────────

class Contract {
  constructor(data) {
    this.id = data.id;
    this.title = data.title || '';
    this.created_at = data.created_at || new Date().toISOString();
    this.status = data.status || STATUSES.DRAFT;
    this.brief = data.brief || '';
    this.assertions = (data.assertions || []).map((a) => ({
      id: a.id,
      text: String(a.text || ''),
      state: a.state || STATES.PENDING,
      evidence: a.evidence || null,
      last_check: a.last_check || null,
    }));
    this.features = data.features || [];
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      created_at: this.created_at,
      status: this.status,
      brief: this.brief,
      assertions: this.assertions,
      features: this.features,
    };
  }

  pending() { return this.assertions.filter((a) => a.state === STATES.PENDING); }
  failed()  { return this.assertions.filter((a) => a.state === STATES.FAILED); }
  passed()  { return this.assertions.filter((a) => a.state === STATES.PASSED); }
  skipped() { return this.assertions.filter((a) => a.state === STATES.SKIPPED); }

  // The done-guard lives here. A contract is "complete" only when every
  // assertion is PASSED or SKIPPED — pending and failed both block.
  isDone() {
    if (this.assertions.length === 0) return false;
    return this.assertions.every((a) => a.state === STATES.PASSED || a.state === STATES.SKIPPED);
  }

  doneStatus() {
    const total = this.assertions.length;
    const passed = this.passed().length;
    const failed = this.failed().length;
    const pending = this.pending().length;
    const skipped = this.skipped().length;
    return {
      done: this.isDone(),
      total,
      passed,
      failed,
      pending,
      skipped,
      blockers: [...this.pending(), ...this.failed()].map((a) => ({ id: a.id, text: a.text, state: a.state })),
    };
  }

  setAssertionState(assertionId, state, opts = {}) {
    if (!Object.values(STATES).includes(state)) {
      throw new Error(`invalid assertion state: ${state}`);
    }
    const a = this.assertions.find((x) => x.id === assertionId);
    if (!a) throw new Error(`assertion not found: ${assertionId}`);
    a.state = state;
    if (opts.evidence !== undefined) a.evidence = opts.evidence || null;
    if (opts.lastCheck !== undefined) a.last_check = opts.lastCheck || null;
    return a;
  }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────
//
// Accepts either a markdown bullet/numbered list or a plain newline-separated
// list. Emits a normalised assertion array.

function parseAssertions(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((s, i) => String(s || '').trim())
      .filter(Boolean)
      .map((text, i) => ({ id: newAssertionId(i), text, state: STATES.PENDING, evidence: null, last_check: null }));
  }
  const lines = String(input).split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Strip leading bullet/number markers
    const cleaned = line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (!cleaned) continue;
    out.push({
      id: newAssertionId(out.length),
      text: cleaned,
      state: STATES.PENDING,
      evidence: null,
      last_check: null,
    });
  }
  return out;
}

module.exports = {
  // constants
  STATES,
  STATUSES,
  // class
  Contract,
  // helpers
  contractsDir,
  activeFile,
  contractDir,
  statePath,
  logPath,
  newContractId,
  newAssertionId,
  writeAtomic,
  appendJsonl,
  renderContractMd,
  renderAssertionsMd,
  parseAssertions,
};
