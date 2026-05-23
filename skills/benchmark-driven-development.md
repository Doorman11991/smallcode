---
name: benchmark-driven-development
trigger: manual
keywords: [bench, benchmark, regression, performance, scoreboard, prompt-tuning, knob]
---

# Benchmark-Driven Development

**No agent-behaviour change ships without a measured before/after.** Vibes are
not evidence. "It should help" is not a result. A change is allowed to land
only if a side-by-side run shows it moved the metric we care about — or if it
didn't, the change is reverted or kept behind a flag that defaults off.

Adapted from itsy's [`benchmark-driven-development`](https://github.com/jukefr/itsy/blob/main/.agents/skills/benchmark-driven-development/SKILL.md)
skill, scoped to SmallCode's bench harness.

## Use when

- About to commit any change that could shift the agent's decision making:
  new tool, schema change, prompt edit, system-prompt section, plan-tracker
  tweak, dedup rule, max-tokens heuristic, model-client retry logic, new
  config flag.
- A change "feels obviously right" — that's exactly when measurement was
  skipped.
- Re-tuning an existing knob (bumping `SMALLCODE_THINKING_BUDGET` from 2000
  to 4000, widening `SMALLCODE_DEDUP_WINDOW`, etc.).
- Comparing two implementations of the same thing.

**Don't use for:** pure bug fixes that match an existing test, dependency
bumps, doc-only changes, internal refactors that don't change behaviour.

## The flow

1. **Pin a baseline commit.** `git rev-parse HEAD` before touching anything.
2. **Run a baseline benchmark.** Pick one of the suites:
   - `npm run bench:smoke` — 5 trivial tasks, ~30 s
   - `npm run bench:polyglot` — 19 tasks across Python / JS / TS / Bash / Markdown / JSON
   - `npm run bench:tools` — 10 multi-step tool sequencing tasks
3. **Snapshot results.** Each suite writes to `.smallcode/benchmarks/`.
   Copy that dir into `bench/baselines/<short-name>/` — that's your reference.
4. **Implement the change.** No rush — the baseline is now ground truth.
5. **Run the same suite on the feature branch.** Same model, same tasks.
   Snapshot under `bench/baselines/<feature-name>/`.
6. **Compare.** `node bench/diff.js bench/baselines/<base> bench/baselines/<feature>`.
   It prints mean reward delta, per-task pass-count diff, wall-clock delta,
   and a verdict line. Exit code: `0` improvement, `1` regression, `2` noise.
7. **Decide.** Pass → commit. Fail → revert or gate behind a default-off flag.
   Mixed → write the trade-off in the commit body so future-you can re-evaluate.

## What counts as moving the right way

| Metric | Good | Suspicious | Bad |
|---|---|---|---|
| Mean reward | +0.03 or more | ±0.01 (noise) | regression |
| Per-task pass count | no task regresses | one task swings −1 | any task drops to 0/N from ≥2/N |
| Wall clock | within ±15% | +30–50% | +2× |
| Cost ($) | within ±10% | +20% | +50% |

A 0.01 delta on a 10-task suite is noise. Bump attempts (`--attempts 5`) if
you need a tighter estimate.

## Common rationalizations

| Excuse | Reality |
|---|---|
| "It's just a prompt tweak, no need to bench" | Every prompt tweak in this codebase has moved scores ±10% in *both* directions. You can't predict the sign. Measure. |
| "I'll bench later when there's a slow moment" | Later = never. A baseline run is ~30 s for smoke. Do it before you start coding. |
| "It only affects feature X, not other tasks" | Cross-cutting changes (tool list, system prompt, plan tracker) touch every task. |
| "I'll just run one task to spot-check" | n=1 is the failure mode of this whole genre of changes. Run the suite. |
| "The baseline from last week is fine" | Baselines drift with model swaps, llama.cpp upgrades, dependency bumps. Re-baseline from the same commit you're branching from. |
| "It's obviously an improvement — look at the agent log" | One log is a single sample. The model is high-variance at IQ2. Use the verifier-pass numbers. |
| "Measurement adds friction to iteration" | Iteration without measurement is sliding sideways. The friction is the point. |

## Red flags — stop and run the baseline

- About to type `git commit` and there's no `bench/baselines/*` dir paired with
  this branch.
- Haven't run a bench in the last hour but the diff is non-trivial.
- The PR description says "should improve X" without a number.
- Tuning a knob with no baseline to compare against.
- The change is "to fix a single failure I saw" — without checking it doesn't
  break the other N.

## SmallCode tips

- Set `SMALLCODE_MODEL` and `SMALLCODE_BASE_URL` consistently across baseline
  and feature runs.
- Use `--run` or `--ci` flags on test runners when applicable so jobs don't
  hang in watch mode.
- After a green diff, `memory_remember` type `workflow` with the bench command,
  the model used, and the deltas — future runs benefit.
