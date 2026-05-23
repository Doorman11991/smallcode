#!/usr/bin/env node
// SmallCode — Benchmark Diff
//
// Compare two harness runs (or a stored baseline vs a fresh run) and decide
// whether a change improved, regressed, or made no measurable difference.
//
// Usage:
//   node bench/diff.js <baseline> <feature> [--threshold 0.02]
//
//   <baseline> / <feature> can be either:
//     - a single .json file written by bench/harness.js
//     - a directory containing one such .json (newest is used)
//
// Exit codes:
//   0   improvement (mean reward delta >= +threshold AND no per-task hard regression)
//   1   regression  (mean reward delta <= -threshold OR a task dropped to 0/N from >= 2/N)
//   2   noise       (delta within ±threshold)
//   3   usage / IO error
//
// Adapted from itsy's `.agents/skills/benchmark-driven-development/diff.py`,
// rewritten in plain Node for SmallCode's bench harness format.

'use strict';

const fs = require('fs');
const path = require('path');

// ─── arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], threshold: 0.02, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold' || a === '-t') {
      args.threshold = parseFloat(argv[++i]);
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`);
      process.exit(3);
    } else {
      args._.push(a);
    }
  }
  if (!Number.isFinite(args.threshold)) args.threshold = 0.02;
  return args;
}

function usage() {
  console.log('Usage: node bench/diff.js <baseline> <feature> [--threshold 0.02] [--json]');
  console.log('');
  console.log('  Each argument is a harness JSON file or a directory containing one.');
  console.log('  Exit: 0 improved, 1 regressed, 2 noise, 3 usage/IO.');
}

// ─── result loading ──────────────────────────────────────────────────────────

function loadRun(arg) {
  if (!fs.existsSync(arg)) {
    throw new Error(`not found: ${arg}`);
  }
  const stat = fs.statSync(arg);
  let target = arg;
  if (stat.isDirectory()) {
    const candidates = fs.readdirSync(arg)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(arg, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length === 0) throw new Error(`no .json files in ${arg}`);
    target = candidates[0];
  }
  const raw = fs.readFileSync(target, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`malformed JSON in ${target}: ${e.message}`);
  }
  if (!Array.isArray(data.results)) {
    throw new Error(`${target}: missing "results" array — not a harness output?`);
  }
  return { path: target, data };
}

// ─── metric extraction ───────────────────────────────────────────────────────

function summarize(run) {
  const results = run.data.results;
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const reward = total > 0 ? passed / total : 0;
  const totalMs = results.reduce((s, r) => s + (r.elapsedMs || 0), 0);
  const totalToolCalls = results.reduce((s, r) => s + (r.toolCalls || 0), 0);
  // Build a per-task pass map keyed by `id` for diffing.
  const byId = {};
  for (const r of results) {
    byId[r.id] = {
      passed: !!r.passed,
      elapsedMs: r.elapsedMs || 0,
      toolCalls: r.toolCalls || 0,
      verifyError: r.verifyError || null,
    };
  }
  return { passed, total, reward, totalMs, totalToolCalls, byId };
}

// ─── verdict ─────────────────────────────────────────────────────────────────

const VERDICT = {
  IMPROVED: 'IMPROVED',
  REGRESSED: 'REGRESSED',
  NOISE: 'NOISE',
};

function verdict(deltaReward, taskRegressions, threshold) {
  if (taskRegressions.hard.length > 0) return VERDICT.REGRESSED;
  if (deltaReward >= threshold) return VERDICT.IMPROVED;
  if (deltaReward <= -threshold) return VERDICT.REGRESSED;
  return VERDICT.NOISE;
}

function exitCodeFor(v) {
  if (v === VERDICT.IMPROVED) return 0;
  if (v === VERDICT.REGRESSED) return 1;
  return 2;
}

// ─── per-task regression check ───────────────────────────────────────────────
//
// Mirrors itsy's "no task should drop from passing-majority to 0" rule.
// `hard` regression: task passed in baseline, fails in feature.
// `soft` regression: same task ID went from >=1 attempt-pass to 0 — we only
//   have one attempt per task in the current harness, so soft == hard for now.

function classifyTaskMoves(base, feat) {
  const hard = []; // baseline pass → feature fail
  const recovered = []; // baseline fail → feature pass
  const allIds = new Set([...Object.keys(base.byId), ...Object.keys(feat.byId)]);
  for (const id of allIds) {
    const b = base.byId[id];
    const f = feat.byId[id];
    if (!b || !f) continue; // task added or removed — skip silently
    if (b.passed && !f.passed) hard.push(id);
    if (!b.passed && f.passed) recovered.push(id);
  }
  return { hard, recovered };
}

// ─── rendering ───────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};
const colorize = (process.stdout.isTTY && !process.env.NO_COLOR);
function paint(text, code) { return colorize ? `${code}${text}${C.reset}` : text; }

function pct(n) { return `${(n * 100).toFixed(1)}%`; }
function ms(n) { return `${(n / 1000).toFixed(1)}s`; }
function signed(n, digits = 3) {
  const s = n.toFixed(digits);
  return n >= 0 ? `+${s}` : s;
}

function render(baseSum, featSum, moves, v, threshold, basePath, featPath) {
  const deltaReward = featSum.reward - baseSum.reward;
  const deltaMs = featSum.totalMs - baseSum.totalMs;
  const deltaCalls = featSum.totalToolCalls - baseSum.totalToolCalls;

  const verdictColor = v === VERDICT.IMPROVED ? C.green
    : v === VERDICT.REGRESSED ? C.red
    : C.yellow;

  console.log('');
  console.log(paint('  SmallCode bench diff', C.bold));
  console.log(paint('  ──────────────────────────────────────────', C.dim));
  console.log(`  baseline : ${paint(basePath, C.cyan)}`);
  console.log(`  feature  : ${paint(featPath, C.cyan)}`);
  console.log('');
  console.log(`  reward   : ${pct(baseSum.reward)}  →  ${pct(featSum.reward)}   (Δ ${paint(signed(deltaReward), verdictColor)})`);
  console.log(`  passed   : ${baseSum.passed}/${baseSum.total}  →  ${featSum.passed}/${featSum.total}`);
  console.log(`  walltime : ${ms(baseSum.totalMs)}  →  ${ms(featSum.totalMs)}   (Δ ${signed(deltaMs / 1000, 1)}s)`);
  console.log(`  toolcall : ${baseSum.totalToolCalls}  →  ${featSum.totalToolCalls}   (Δ ${signed(deltaCalls, 0)})`);
  console.log('');

  if (moves.hard.length > 0) {
    console.log(paint(`  ✗ Regressed tasks (${moves.hard.length}):`, C.red));
    for (const id of moves.hard) console.log(`      ${id}`);
  }
  if (moves.recovered.length > 0) {
    console.log(paint(`  ✓ Recovered tasks (${moves.recovered.length}):`, C.green));
    for (const id of moves.recovered) console.log(`      ${id}`);
  }
  if (moves.hard.length === 0 && moves.recovered.length === 0) {
    console.log(paint('  no per-task moves', C.dim));
  }

  console.log('');
  console.log(`  threshold: ±${threshold}`);
  console.log(`  verdict  : ${paint(v, verdictColor + C.bold)}`);
  console.log('');
}

// ─── main ────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);
  if (args.help || args._.length !== 2) {
    usage();
    process.exit(args.help ? 0 : 3);
  }
  const [baseArg, featArg] = args._;
  let baseRun, featRun;
  try {
    baseRun = loadRun(baseArg);
    featRun = loadRun(featArg);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(3);
  }

  const baseSum = summarize(baseRun);
  const featSum = summarize(featRun);
  const moves = classifyTaskMoves(baseSum, featSum);
  const deltaReward = featSum.reward - baseSum.reward;
  const v = verdict(deltaReward, moves, args.threshold);
  const code = exitCodeFor(v);

  if (args.json) {
    process.stdout.write(JSON.stringify({
      verdict: v,
      exitCode: code,
      threshold: args.threshold,
      delta: { reward: deltaReward, totalMs: featSum.totalMs - baseSum.totalMs, totalToolCalls: featSum.totalToolCalls - baseSum.totalToolCalls },
      baseline: { path: baseRun.path, passed: baseSum.passed, total: baseSum.total, reward: baseSum.reward, totalMs: baseSum.totalMs },
      feature: { path: featRun.path, passed: featSum.passed, total: featSum.total, reward: featSum.reward, totalMs: featSum.totalMs },
      regressed: moves.hard,
      recovered: moves.recovered,
    }, null, 2) + '\n');
  } else {
    render(baseSum, featSum, moves, v, args.threshold, baseRun.path, featRun.path);
  }
  process.exit(code);
}

if (require.main === module) main();

module.exports = { loadRun, summarize, classifyTaskMoves, verdict, VERDICT };
