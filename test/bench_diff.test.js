// Tests for bench/diff.js — verdict and metric extraction.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadRun, summarize, classifyTaskMoves, verdict, VERDICT } = require('../bench/diff');

const DIFF = path.join(__dirname, '..', 'bench', 'diff.js');

function makeRun(results) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-diff-'));
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify({
    runId: 'fake',
    suite: 'smoke',
    model: 'mock',
    summary: { passed: results.filter((r) => r.passed).length, total: results.length, totalMs: 0, meanMs: 0 },
    results,
  }, null, 2));
  return file;
}

// ─── unit ───────────────────────────────────────────────────────────────────

test('summarize() computes pass rate, walltime, tool calls', () => {
  const file = makeRun([
    { id: 'a', lang: 'py', passed: true, elapsedMs: 1000, toolCalls: 3 },
    { id: 'b', lang: 'py', passed: false, elapsedMs: 2000, toolCalls: 5 },
    { id: 'c', lang: 'py', passed: true, elapsedMs: 1500, toolCalls: 2 },
  ]);
  const run = loadRun(file);
  const s = summarize(run);
  assert.equal(s.passed, 2);
  assert.equal(s.total, 3);
  assert.ok(Math.abs(s.reward - 2 / 3) < 1e-9);
  assert.equal(s.totalMs, 4500);
  assert.equal(s.totalToolCalls, 10);
});

test('classifyTaskMoves identifies hard regressions and recoveries', () => {
  const baseline = makeRun([
    { id: 'pass-pass', lang: 'py', passed: true, elapsedMs: 0, toolCalls: 0 },
    { id: 'pass-fail', lang: 'py', passed: true, elapsedMs: 0, toolCalls: 0 },
    { id: 'fail-pass', lang: 'py', passed: false, elapsedMs: 0, toolCalls: 0 },
    { id: 'fail-fail', lang: 'py', passed: false, elapsedMs: 0, toolCalls: 0 },
  ]);
  const feature = makeRun([
    { id: 'pass-pass', lang: 'py', passed: true, elapsedMs: 0, toolCalls: 0 },
    { id: 'pass-fail', lang: 'py', passed: false, elapsedMs: 0, toolCalls: 0 },
    { id: 'fail-pass', lang: 'py', passed: true, elapsedMs: 0, toolCalls: 0 },
    { id: 'fail-fail', lang: 'py', passed: false, elapsedMs: 0, toolCalls: 0 },
  ]);
  const moves = classifyTaskMoves(summarize(loadRun(baseline)), summarize(loadRun(feature)));
  assert.deepEqual(moves.hard, ['pass-fail']);
  assert.deepEqual(moves.recovered, ['fail-pass']);
});

test('verdict — improvement above threshold', () => {
  const v = verdict(0.05, { hard: [] }, 0.02);
  assert.equal(v, VERDICT.IMPROVED);
});

test('verdict — regression below negative threshold', () => {
  const v = verdict(-0.05, { hard: [] }, 0.02);
  assert.equal(v, VERDICT.REGRESSED);
});

test('verdict — within threshold = noise', () => {
  const v = verdict(0.01, { hard: [] }, 0.02);
  assert.equal(v, VERDICT.NOISE);
});

test('verdict — hard regression overrides everything', () => {
  // Even with a positive delta, a task dropping from pass→fail is a regression.
  const v = verdict(0.10, { hard: ['x'] }, 0.02);
  assert.equal(v, VERDICT.REGRESSED);
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

test('CLI exits 0 on improvement', () => {
  const baseline = makeRun([
    { id: 'a', lang: 'py', passed: false, elapsedMs: 1000, toolCalls: 1 },
    { id: 'b', lang: 'py', passed: true, elapsedMs: 1000, toolCalls: 1 },
  ]);
  const feature = makeRun([
    { id: 'a', lang: 'py', passed: true, elapsedMs: 1000, toolCalls: 1 },
    { id: 'b', lang: 'py', passed: true, elapsedMs: 1000, toolCalls: 1 },
  ]);
  const r = spawnSync(process.execPath, [DIFF, baseline, feature, '--json'], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'IMPROVED');
});

test('CLI exits 1 on regression', () => {
  const baseline = makeRun([
    { id: 'a', lang: 'py', passed: true, elapsedMs: 1000, toolCalls: 1 },
    { id: 'b', lang: 'py', passed: true, elapsedMs: 1000, toolCalls: 1 },
  ]);
  const feature = makeRun([
    { id: 'a', lang: 'py', passed: false, elapsedMs: 1000, toolCalls: 1 },
    { id: 'b', lang: 'py', passed: true, elapsedMs: 1000, toolCalls: 1 },
  ]);
  const r = spawnSync(process.execPath, [DIFF, baseline, feature, '--json'], { encoding: 'utf-8' });
  assert.equal(r.status, 1);
});

test('CLI exits 2 on noise', () => {
  const baseline = makeRun([
    { id: 'a', lang: 'py', passed: true, elapsedMs: 1000, toolCalls: 1 },
    { id: 'b', lang: 'py', passed: true, elapsedMs: 1000, toolCalls: 1 },
  ]);
  const feature = makeRun([
    { id: 'a', lang: 'py', passed: true, elapsedMs: 1000, toolCalls: 1 },
    { id: 'b', lang: 'py', passed: true, elapsedMs: 1100, toolCalls: 1 },
  ]);
  const r = spawnSync(process.execPath, [DIFF, baseline, feature, '--json'], { encoding: 'utf-8' });
  assert.equal(r.status, 2);
});

test('CLI accepts a directory and picks the newest .json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-diff-dir-'));
  const oldFile = path.join(dir, 'old.json');
  const newFile = path.join(dir, 'new.json');
  fs.writeFileSync(oldFile, JSON.stringify({ summary: {}, results: [{ id: 'a', lang: 'py', passed: false, elapsedMs: 0, toolCalls: 0 }] }));
  // Sleep-equivalent: bump mtime explicitly
  const future = new Date(Date.now() + 5000);
  fs.writeFileSync(newFile, JSON.stringify({ summary: {}, results: [{ id: 'a', lang: 'py', passed: true, elapsedMs: 0, toolCalls: 0 }] }));
  fs.utimesSync(newFile, future, future);

  const baseline = makeRun([{ id: 'a', lang: 'py', passed: false, elapsedMs: 0, toolCalls: 0 }]);
  const r = spawnSync(process.execPath, [DIFF, baseline, dir, '--json'], { encoding: 'utf-8' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.feature.path, newFile);
});

test('CLI usage error returns exit 3', () => {
  const r = spawnSync(process.execPath, [DIFF, 'only-one-arg'], { encoding: 'utf-8' });
  assert.equal(r.status, 3);
});
