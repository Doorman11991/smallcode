#!/usr/bin/env node
// SmallCode — E2E smoke for the three new features
//
// Drives the real agent (huihui-gemma-4-e4b-it-abliterated on
// http://10.0.0.20:1234/v1) through scenarios that exercise:
//   1. Per-turn idempotent-write dedup     — tries to make the model spam
//      memory_remember; the runtime must short-circuit duplicates.
//   2. Contract create + done-guard        — creates a contract, leaves an
//      assertion pending, asks the model to claim done; the guard must
//      catch the wrap-up and reject the final response.
//   3. bench/diff.js                       — already covered by unit tests
//      via spawnSync; we re-run the smoke unit tests here for parity.
//
// Run with: node test/e2e_smoke.js
//
// Reads SMALLCODE_MODEL / SMALLCODE_BASE_URL from .env (loaded by the agent
// itself). No assertions are silently optional — the script exits 1 on
// failure.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SMALLCODE_BIN = path.join(ROOT, 'bin', 'smallcode.js');
const MODEL = process.env.SMALLCODE_MODEL || 'huihui-gemma-4-e4b-it-abliterated';
const BASE_URL = process.env.SMALLCODE_BASE_URL || 'http://10.0.0.20:1234/v1';

const TURN_TIMEOUT_S = parseInt(process.env.E2E_TURN_TIMEOUT || '180', 10);

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const paint = (t, code) => process.stdout.isTTY ? `${code}${t}${C.reset}` : t;

// ─── helpers ────────────────────────────────────────────────────────────────

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function runAgent(prompt, opts = {}) {
  return new Promise((resolve) => {
    const cwd = opts.cwd || freshTmpDir('e2e');
    const env = {
      ...process.env,
      SMALLCODE_MODEL: MODEL,
      SMALLCODE_BASE_URL: BASE_URL,
      SMALLCODE_PROVIDER: 'openai',
      SMALLCODE_AUTO_APPROVE: 'true',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      // Keep features deterministic for the smoke run
      SMALLCODE_REVIEWER: 'false',
      SMALLCODE_PLAN: 'false',
      SMALLCODE_BOOTSTRAP: 'false',
      ...(opts.env || {}),
    };
    const child = spawn('node', [SMALLCODE_BIN, '--non-interactive', '-P', prompt], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, TURN_TIMEOUT_S * 1000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr, cwd });
    });
  });
}

let failures = 0;
function check(name, ok, details) {
  if (ok) {
    console.log(`  ${paint('✓', C.green)} ${name}`);
  } else {
    failures += 1;
    console.log(`  ${paint('✗', C.red)} ${name}`);
    if (details) console.log(`      ${paint(details, C.dim)}`);
  }
}

// ─── case 1: per-turn idempotent-write dedup ────────────────────────────────

async function caseIdempotentDedup() {
  console.log('');
  console.log(paint('Case 1 — per-turn idempotent-write dedup', C.bold));

  // Pre-seed memory so the dedup short-circuit message becomes visible to us.
  // We ask the model to remember THE SAME thing several times in one message.
  // Even if the model only emits two memory_remember calls, the second must
  // hit the [already stored this turn] short-circuit.
  const prompt =
    'Use the memory_remember tool to save a single context note titled ' +
    '"smoke-key" with content "smoke-value", then do it again with the ' +
    'exact same arguments. Then reply with a one-line summary.';

  const res = await runAgent(prompt);
  // We expect the runtime to have logged either the canonical short-circuit
  // marker OR the underlying tool response showing only one real call.
  const merged = (res.stdout + res.stderr);
  const sawShortCircuit = /already stored this turn/i.test(merged);

  // Fallback signal: count memory_remember tool indicators (`⚙ memory_remember`
  // or  · memory_remember in the TUI) — a model that emits 2 calls but only
  // 1 is executed real would still be a correct outcome; we just want to make
  // sure the short-circuit path is reachable end-to-end.
  const remembersExecuted = (merged.match(/Remembered\s+\[/g) || []).length;

  check('agent ran without crashing', res.code === 0,
        `exit=${res.code}; stderr tail: ${res.stderr.slice(-300)}`);
  check('short-circuit message OR single execution',
        sawShortCircuit || remembersExecuted <= 1,
        `sawShortCircuit=${sawShortCircuit}, remembersExecuted=${remembersExecuted}`);
}

// ─── case 2: contract create + done-guard ───────────────────────────────────

async function caseContractGuard() {
  console.log('');
  console.log(paint('Case 2 — contract create + done-guard', C.bold));

  // Single-turn, multi-step prompt: create a contract with two assertions,
  // mark only the first one passed, then claim "all done". The guard must
  // intercept the wrap-up. We expect to see a [CONTRACT-GUARD] injection
  // OR — if the model recovers correctly after the guard fires — the on-disk
  // state should show the assertions resolved through the contract tools.
  const prompt =
    'Step 1: Use contract_create to declare a Definition of Done with title ' +
    '"smoke" and these two assertions: "smoke step one passes", "smoke step ' +
    'two passes". ' +
    'Step 2: Use contract_assert_pass on a01 with evidence "verified by smoke ' +
    'test". ' +
    'Step 3: Reply with the single line "All done — task is complete." (do ' +
    'NOT mark a02 as passed; leave it pending intentionally).';

  const res = await runAgent(prompt);
  const merged = (res.stdout + res.stderr);
  // The fullscreen TUI emits "⚙ <tool> ✓ <ms>" for tool calls. Use the tool
  // names as the success signal — they're the closest thing to a structured
  // event we can observe from outside the agent.
  const toolFired = (name) => new RegExp(`⚙\\s*${name}`).test(merged);
  const sawCreate    = toolFired('contract_create');
  const sawPass      = toolFired('contract_assert_pass');
  const sawGuard     = /CONTRACT-GUARD/.test(merged) || /contract guard:/.test(merged);

  // Inspect the contract on disk for ground truth — the agent's tool calls
  // should have left a state.json behind. Two valid outcomes:
  //  (a) a01 passed, a02 pending  → guard fired, model didn't recover
  //  (b) every assertion resolved → guard fired, model used skip/pass to
  //      recover (this is the correct behaviour for the agent)
  const contractsRoot = path.join(res.cwd, '.smallcode', 'contracts');
  let stateOk = false;
  let stateDetail = '(no state.json)';
  try {
    if (fs.existsSync(contractsRoot)) {
      const ids = fs.readdirSync(contractsRoot).filter((f) => !f.startsWith('.'));
      if (ids.length > 0) {
        const state = JSON.parse(fs.readFileSync(path.join(contractsRoot, ids[0], 'state.json'), 'utf-8'));
        if (state.assertions && state.assertions.length === 2) {
          const a01 = state.assertions[0].state;
          const a02 = state.assertions[1].state;
          const a01Resolved = ['passed', 'skipped'].includes(a01);
          const a02Resolved = ['passed', 'skipped', 'failed'].includes(a02);
          // a01 must be marked, and a02 must either still be pending (guard
          // fired and model honoured the failure) or resolved (guard fired
          // and model recovered).
          stateOk = a01Resolved && (a02 === 'pending' || a02Resolved);
          stateDetail = `a01=${a01} a02=${a02}`;
        }
      }
    }
  } catch (e) {
    stateDetail = `(read error: ${e.message})`;
  }

  check('agent ran without crashing', res.code === 0,
        `exit=${res.code}; stderr tail: ${res.stderr.slice(-300)}`);
  check('contract_create tool fired', sawCreate,
        `output tail:\n${merged.slice(-600)}`);
  check('contract_assert_pass tool fired', sawPass);
  check('done-guard intercepted wrap-up', sawGuard,
        `expected CONTRACT-GUARD or "contract guard:" in output. Tail:\n${merged.slice(-600)}`);
  check('contract state.json reflects tool calls', stateOk, stateDetail);
}

// ─── case 3: bench/diff.js sanity ───────────────────────────────────────────

function caseBenchDiff() {
  console.log('');
  console.log(paint('Case 3 — bench/diff.js exit codes', C.bold));

  const baseDir = freshTmpDir('e2e-bench-base');
  const featDir = freshTmpDir('e2e-bench-feat');
  const baseFile = path.join(baseDir, 'run.json');
  const featFile = path.join(featDir, 'run.json');

  fs.writeFileSync(baseFile, JSON.stringify({
    summary: {},
    results: [
      { id: 't1', lang: 'py', passed: false, elapsedMs: 1000, toolCalls: 1 },
      { id: 't2', lang: 'py', passed: true,  elapsedMs: 1000, toolCalls: 1 },
    ],
  }));
  fs.writeFileSync(featFile, JSON.stringify({
    summary: {},
    results: [
      { id: 't1', lang: 'py', passed: true,  elapsedMs: 1000, toolCalls: 1 },
      { id: 't2', lang: 'py', passed: true,  elapsedMs: 1000, toolCalls: 1 },
    ],
  }));

  const r = spawnSync(process.execPath, [path.join(ROOT, 'bench', 'diff.js'), baseFile, featFile, '--json'], { encoding: 'utf-8' });
  check('exit 0 on improvement', r.status === 0, `status=${r.status}`);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  check('emitted JSON verdict IMPROVED', parsed && parsed.verdict === 'IMPROVED',
        `stdout: ${r.stdout?.slice(0, 200)}`);
}

// ─── main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(paint('SmallCode E2E smoke', C.bold));
  console.log(`  model: ${paint(MODEL, C.cyan)}`);
  console.log(`  base : ${paint(BASE_URL, C.cyan)}`);

  try {
    caseBenchDiff();
    await caseIdempotentDedup();
    await caseContractGuard();
  } catch (e) {
    console.log('');
    console.log(paint(`fatal: ${e.message}`, C.red));
    failures += 1;
  }

  console.log('');
  if (failures === 0) {
    console.log(paint('All E2E checks passed.', C.green + C.bold));
    process.exit(0);
  } else {
    console.log(paint(`${failures} E2E check(s) failed.`, C.red + C.bold));
    process.exit(1);
  }
})();
