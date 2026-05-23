// SmallCode — Contract Store
//
// File-backed CRUD layer for src/session/contract.js. Singleton per process
// because the active-contract pointer (`.active`) needs to round-trip across
// tool calls within a session without rebuilding the whole state.
//
// Public surface:
//   getStore(cwd)
//     .create({ title, brief, assertions })  → Contract
//     .get(id)                               → Contract | null
//     .save(contract)                        → void
//     .list()                                → [{ id, title, status, doneStatus }]
//     .activate(id)                          → void
//     .deactivate()                          → void
//     .activeId()                            → id | null
//     .active()                              → Contract | null
//     .markAssertion(id, state, opts)        → Contract
//     .abort(id, reason)                     → Contract
//     .complete(id)                          → Contract

'use strict';

const fs = require('fs');
const path = require('path');

const {
  Contract,
  STATES,
  STATUSES,
  contractsDir,
  activeFile,
  contractDir,
  statePath,
  logPath,
  newContractId,
  writeAtomic,
  appendJsonl,
  renderContractMd,
  renderAssertionsMd,
  parseAssertions,
} = require('./contract');

class ContractStore {
  constructor(cwd) {
    this.cwd = cwd || process.cwd();
  }

  // ─── pointers ──────────────────────────────────────────────────────────────

  activeId() {
    const p = activeFile(this.cwd);
    if (!fs.existsSync(p)) return null;
    const id = fs.readFileSync(p, 'utf-8').trim();
    return id || null;
  }

  active() {
    const id = this.activeId();
    if (!id) return null;
    return this.get(id);
  }

  activate(id) {
    const c = this.get(id);
    if (!c) throw new Error(`contract not found: ${id}`);
    if (c.status === STATUSES.DRAFT) {
      c.status = STATUSES.ACTIVE;
      this.save(c);
    }
    fs.mkdirSync(contractsDir(this.cwd), { recursive: true });
    writeAtomic(activeFile(this.cwd), id);
    this._log(c.id, 'activate', {});
  }

  deactivate() {
    const p = activeFile(this.cwd);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // ─── persistence ───────────────────────────────────────────────────────────

  get(id) {
    if (!id) return null;
    const p = statePath(id, this.cwd);
    if (!fs.existsSync(p)) return null;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const data = JSON.parse(raw);
      return new Contract(data);
    } catch (e) {
      throw new Error(`failed to load contract ${id}: ${e.message}`);
    }
  }

  save(contract) {
    if (!(contract instanceof Contract)) contract = new Contract(contract);
    const dir = contractDir(contract.id, this.cwd);
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(statePath(contract.id, this.cwd), JSON.stringify(contract.toJSON(), null, 2) + '\n');
    writeAtomic(path.join(dir, 'contract.md'), renderContractMd(contract));
    writeAtomic(path.join(dir, 'assertions.md'), renderAssertionsMd(contract));
  }

  list() {
    const root = contractsDir(this.cwd);
    if (!fs.existsSync(root)) return [];
    const ids = fs.readdirSync(root)
      .filter((name) => !name.startsWith('.'))
      .filter((name) => fs.statSync(path.join(root, name)).isDirectory());
    const out = [];
    for (const id of ids) {
      const c = this.get(id);
      if (!c) continue;
      out.push({
        id: c.id,
        title: c.title,
        status: c.status,
        created_at: c.created_at,
        doneStatus: c.doneStatus(),
      });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  create({ title, brief, assertions }) {
    const id = newContractId();
    const parsed = parseAssertions(assertions);
    if (parsed.length === 0) {
      throw new Error('cannot create contract with zero assertions — supply at least one');
    }
    const c = new Contract({
      id,
      title: title || 'Untitled contract',
      brief: brief || '',
      assertions: parsed,
      status: STATUSES.DRAFT,
    });
    this.save(c);
    this._log(id, 'create', { title: c.title, assertion_count: c.assertions.length });
    return c;
  }

  markAssertion(assertionId, state, opts = {}) {
    const id = opts.contractId || this.activeId();
    if (!id) throw new Error('no active contract — run /contract activate <id> first');
    const c = this.get(id);
    if (!c) throw new Error(`active contract missing on disk: ${id}`);
    c.setAssertionState(assertionId, state, opts);
    this.save(c);
    this._log(c.id, 'mark', { assertion_id: assertionId, state, evidence: opts.evidence ? opts.evidence.slice(0, 200) : null });
    // Auto-complete when every assertion is done
    if (c.isDone() && c.status !== STATUSES.COMPLETED) {
      c.status = STATUSES.COMPLETED;
      this.save(c);
      this._log(c.id, 'auto_complete', {});
    }
    return c;
  }

  abort(reason, opts = {}) {
    const id = opts.contractId || this.activeId();
    if (!id) throw new Error('no active contract');
    const c = this.get(id);
    if (!c) throw new Error(`contract missing: ${id}`);
    c.status = STATUSES.ABORTED;
    this.save(c);
    this._log(c.id, 'abort', { reason: reason || '' });
    return c;
  }

  complete(opts = {}) {
    const id = opts.contractId || this.activeId();
    if (!id) throw new Error('no active contract');
    const c = this.get(id);
    if (!c) throw new Error(`contract missing: ${id}`);
    if (!c.isDone()) {
      const status = c.doneStatus();
      throw new Error(
        `cannot complete: ${status.pending} pending, ${status.failed} failed. ` +
        `blockers: ${status.blockers.map((b) => b.id).join(', ')}`,
      );
    }
    c.status = STATUSES.COMPLETED;
    this.save(c);
    this._log(c.id, 'complete', {});
    return c;
  }

  _log(id, event, data) {
    try {
      appendJsonl(logPath(id, this.cwd), {
        ts: new Date().toISOString(),
        event,
        ...data,
      });
    } catch {
      // Logging is best-effort. Don't fail state mutations on log write errors.
    }
  }
}

let _instance = null;
function getStore(cwd) {
  if (!_instance || (cwd && _instance.cwd !== cwd)) {
    _instance = new ContractStore(cwd);
  }
  return _instance;
}
function resetStore() { _instance = null; }

module.exports = { ContractStore, getStore, resetStore, STATES, STATUSES };
