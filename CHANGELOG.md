# Changelog

## [1.2.0] - 2026-05-23

### feat: contract / definition-of-done + per-turn idempotent-write dedup + bench diff

Three additions inspired by [jukefr/itsy](https://github.com/jukefr/itsy)
(SmallCode's downstream Rust port):

- **Contract / Definition-of-Done** — declarative per-project assertion list
  the agent commits to up-front. The agent cannot deliver a final
  "I'm done"-shaped response while any assertion is `pending` or `failed`.
  Declared in MarrowScript at `marrow/contract.marrow` and implemented as a
  hand-port at `src/session/contract.js` plus `contract_store.js` and
  `contract_tools.js`. Five new tools — `contract_create`, `contract_status`,
  `contract_assert_pass`, `contract_assert_fail`, `contract_assert_skip` —
  plus a `/contract` slash command. State persists to
  `.smallcode/contracts/<id>/state.json` with re-rendered `contract.md` and
  `assertions.md` views and a `log.jsonl` audit trail. Disable with
  `SMALLCODE_CONTRACT=false`. The done-guard heuristic lives in
  `src/session/contract_guard.js`.
- **Per-turn idempotent-write dedup** — closes the spam-loop gap where small
  models could call `memory_remember` (or `memory_forget`) with identical
  args 30+ times in a single turn. `PURE_TOOLS` dedup is sliding-window and
  excludes writes; this set is per-turn, scoped to declared idempotent
  writes, and resets between turns. Implemented in
  `src/tools/dedup.js::IdempotentWriteSet` with hooks in
  `bin/smallcode.js`'s `executeTool` wrapper and turn boundary. Disable with
  `SMALLCODE_IDEMPOTENT_WRITE_DEDUP=false`. Inspired by itsy commit 32653f3.
- **Benchmark diff tool + BDD skill** — new `bench/diff.js` compares two
  harness JSON outputs and exits `0` improved / `1` regressed / `2` noise
  with optional `--json` for CI. Skill at
  `skills/benchmark-driven-development.md` adapted from itsy's same-named
  skill. Wired as `npm run bench:diff <baseline> <feature>`.

### Verification

- 46/46 new unit tests across `test/contract.test.js`,
  `test/dedup_idempotent.test.js`, `test/bench_diff.test.js`
- 14/14 existing SSRF guard tests still pass (60/60 total via `npm test`)
- 11/11 E2E checks via `npm run test:e2e` against
  `huihui-gemma-4-e4b-it-abliterated` on `http://10.0.0.20:1234/v1`. Live
  trace: model created the contract, marked `a01` passed, tried to claim
  done, done-guard fired (`⚠ contract guard: 1 unresolved assertion`),
  model recovered by calling `contract_status` then `contract_assert_skip`
  on `a02`, contract auto-completed.

---

## [1.1.0] - 2026-05-23

### feat: tool-call recovery + /version command + SSRF guard hardening

Two issues closed (#36, #40), one external security PR merged (#39).

- **Issue #40 — `/version` returns "Unknown"** — `/version` (and `/v`) now
  print the SmallCode version, package description, and Node/platform info.
  Sourced from `package.json` so the value can never drift. Added to the
  `/help` listing too.
- **Issue #36 — qwen2.5-coder:14b spills tool JSON into chat** — added a
  defensive tool-call extractor (`src/tools/tool_call_extractor.js`) that
  recovers tool invocations the model emitted as text instead of as a
  structured `tool_calls` field. Wired into `bin/smallcode.js`,
  `src/api/index.js`, and `src/session/parallel_executor.js` so all three
  entry points benefit. Recognises four shapes:
  - `<tool_call>{...}</tool_call>` (Hermes / qwen native template)
  - `` ```json ... ``` `` and `` ```tool_call ... ``` `` fences
  - Bare leading JSON object/array
  - `{ "function": { "name", "arguments" } }` and `{ "tool", "args" }` forms
  - Tolerates trailing commas, which qwen sometimes emits.

  Conservative by design — calls referencing unknown tool names are left in
  the chat content rather than executed.
- **PR #39 — SSRF guard bypasses (security)** — closes two adjacent gaps in
  the SSRF guard that let an LLM-controlled `web_fetch` URL reach cloud
  metadata under `LLM_ALLOW_PUBLIC_ENDPOINTS=1`. Thanks to @aaronjmars for
  the report and patch.
  - IPv4-mapped IPv6 aliases (`[::ffff:169.254.169.254]`,
    `[::ffff:a9fe:a9fe]`, `[0:0:0:0:0:ffff:169.254.169.254]`) now route
    through `hostVariants()` and hit `isAlwaysBlocked` like the dotted-quad
    form already did.
  - `_fetchWithBrowser` (Playwright path) now intercepts every per-hop
    request via `page.route` and re-asserts the SSRF guard, so a 302 to a
    metadata IP is rejected before connect — matching the existing
    `redirect: 'manual'` defence in `_fetchSimple`.
  - The `.ts` and `.js` ssrf_guard sources are now in sync, so a future
    `node build.js` won't regress the fix. Origin-equality matching
    replaces the prior `endpoint.startsWith(allow)` (prefix-spoof angle).
  - 14 new regression tests in `test/ssrf_guard.test.js`.

### Verification

- 10/10 tool-call extractor cases (qwen tag, fenced JSON, bare JSON,
  OpenAI-shape, multi-call, unknown-tool rejection, trailing commas, prose
  passthrough, already-structured passthrough, `{tool, args}` variant)
- 3/3 `/version` cases (command, alias, unknown-passthrough)
- 14/14 SSRF guard cases including all five metadata aliases
- Existing 11/11 TUI unit tests still pass
- CI green on Linux, macOS, Windows

---

## [1.0.2] - 2026-05-22

### fix: empty tools array + ~/.smallcode/skills/ support

- **OpenWebUI 400 fix** — `tools` key is now omitted from the request body when
  there are no tools to send. OpenWebUI (and some other endpoints) reject
  `"tools": []` with a `NoneType` error; the key must be absent entirely.
- **`~/.smallcode/skills/`** — added as a recognized global skills directory
  alongside `~/.config/smallcode/skills/`. Both paths now work.

---

## [1.0.1] - 2026-05-22

### fix: /model command sends auth headers

The `/model` command was fetching `/models` without an `Authorization` header.
OpenWebUI and other authenticated endpoints return non-2xx on unauthenticated
requests, causing `/model` to always show `failed`. Now sends the same
`Bearer` token used by all other SmallCode requests.

---

## [1.0.0] - 2026-05-22

### feat: reliability hardening from mebassett fork — 1.0 release

Five upstream fixes from [mebassett's fork](https://github.com/mebassett/smallcode/commits/master/),
each addressing a real failure mode observed in production with reasoning
models on llama-server:

**Executor argument validation (`bin/executor.js`)**
The `patch`, `read_and_patch`, and `create_and_run` handlers now validate that
required string arguments exist before dereferencing. Previously, malformed
tool calls (missing `path`/`old_str`/`new_str`/`content`) crashed the entire
agent process with `TypeError: Cannot read properties of undefined`. Returns
`{ error, kind: 'validation' }` so the agent loop can recover gracefully.

**Poisoned history fix (`bin/smallcode.js`)**
When every tool call in a turn returns a validation error, the bad assistant
message + error tool results are spliced out of `conversationHistory` and
replaced with a single `[SYSTEM]` correction note. Without this, the model
saw its own malformed output and biased toward producing more — death spiral
on small models.

**5xx retry (`bin/smallcode.js`)**
The HTTP retry on `chatCompletion` now triggers on any 4xx OR 5xx response,
not just 4xx. 5xx from llama-server is often a transient tool-call JSON parse
failure that recovers on the next sampling pass. Previously we silently killed
the agent loop on 5xx.

**Max output tokens 4096 → 8192 (env-overridable)**
Reasoning models (Qwen3, DeepSeek-R1, GPT-5.5) emit 2k–6k tokens of `<think>`
content before producing tool calls. With `max_tokens: 4096`, the budget could
be exhausted mid-`tool_calls`, producing truncated/malformed JSON. Default
raised to 8192. Override via `SMALLCODE_MAX_OUTPUT_TOKENS`.

**Tool result truncation cap 4000 → 8000 (env-overridable)**
Per-tool-result truncation cap doubled. 4000 chars (~120 lines) forced the
model into multi-read sequences on most real source files, each costing a
full LLM round-trip. 8000 chars (~240 lines) covers most files in one read.
Override via `SMALLCODE_MAX_TOOL_RESULT_CHARS`.

**Why 1.0:** these reliability fixes plus the v0.9.x series (clarifier
context-awareness, query routing, dependency graph, parallel executor scaffold,
read-loop detection, one-question clarifier) bring SmallCode to a stable
production baseline. Subsequent releases will be incremental on this base.

Files changed: `bin/executor.js`, `bin/smallcode.js`, `.env.example`

Credit: [@mebassett](https://github.com/mebassett) for the fork that surfaced these issues.

---

## [0.9.10] - 2026-05-22

### fix: read-loop detection + one-question clarifier policy

**Read-loop detection (`src/governor/early_stop.js`)**

The early-stop detector now catches the "endless review" failure mode: a model
that calls `read_file`, `find_files`, `graph_search`, etc. repeatedly without
producing any written output. Two thresholds:

- At 5 consecutive read-only calls: soft nudge injected — "you likely have
  enough context, write your findings after the next read"
- At 8 consecutive read-only calls: hard injection + loop break — "you have
  read 8 results, STOP reading and START writing now"

Counter resets when the model writes anything (`write_file`/`patch`) or when
a new turn starts. Works for: `read_file`, `find_files`, `list_projects`,
`graph_search`, `explain_symbol`, `search`, `find_and_read`, `search_and_read`,
`memory_load`.

**One-question clarifier policy (`src/session/clarify.js`, `bin/smallcode.js`)**

The clarification instruction now tells the model to ask its question AND
immediately start executing based on its best interpretation — no waiting for
confirmation. The dev loop no longer pauses after a clarifying question if the
model already issued tool calls in the same response. If the model only asked
without starting work, the `assistantAskedQuestion` guard ensures the clarifier
never re-fires on the user's reply, so the next turn goes straight into execution.

Net behavior: "fix it" → model says "I'm assuming you mean X, quick question: Y?
Starting now..." and proceeds. User steers mid-task if the assumption was wrong.

Files changed: `src/governor/early_stop.js`, `src/session/clarify.js`, `bin/smallcode.js`

---

## [0.9.9] - 2026-05-22

### feat: litecode architecture — query routing, path validation, dependency graph, parallel executor

Four features from the litecode small-context agent design, adapted to SmallCode's architecture:

**Feature 2 — Query routing (`src/session/action_classifier.js`)**
Plan steps are now classified as `query` (read-only) or `mutate` (can write) before tool calls start. Query steps get a filtered tool set that excludes `write_file`, `patch`, `append_file`, `create_and_run`. Prevents "how many lines does X have?" from accidentally overwriting a file. Wired into `getAllTools()` in `bin/smallcode.js`.

**Feature 4 — File path validation (`src/session/dependency_graph.js`)**
After a plan is extracted, all file paths mentioned in plan steps are validated against the filesystem. Missing paths inject an advisory `[PATH-VALIDATION]` system message so the model self-corrects via `find_files` rather than silently misrouting. Non-blocking — new-file creation tasks reference paths that legitimately don't exist yet.

**Feature 3 — Dependency graph orchestrator (`src/session/dependency_graph.js`)**
Pure-code (zero LLM) dependency graph built from plan steps. Two steps touching the same file are marked dependent. Explicit ordering ("after step N") is also detected. Topological sort (Kahn's algorithm) produces parallel execution batches. Batch structure logged to TUI. Stored as `_planTracker._executionBatches` for use by the parallel executor.

**Feature 1 — Parallel executor (`src/session/parallel_executor.js`)**
Executes independent plan steps concurrently using `Promise.all` per batch. Per-file isolation: each parallel step sees only the shared system prompt + its own task instruction (no sibling results). Gated behind `SMALLCODE_PARALLEL=true` env var — off by default until validated in production. Full agent loop integration is v1.0.0 work.

**Bug fixes in implementation:**
- `lastIndex` race condition in path regex patterns (concurrent calls shared state)
- Cycle detection fallback in topological sort could push empty batch
- `buildStepMessages` now enforces system-only message isolation

Files added: `src/session/action_classifier.js`, `src/session/dependency_graph.js`, `src/session/parallel_executor.js`
Files changed: `bin/smallcode.js`

---

## [0.9.8] - 2026-05-21

### fix: clarifier fires on replies to assistant questions (root cause fix)

**Root cause:** the clarifier evaluated every message in isolation. When the model
asked the user a question (e.g. "Do you want me to read, implement, or analyze?"),
the user's reply — however short ("read it", "1 and 2", "go ahead") — was still
passed through `checkNeedsClarification` and falsely flagged as vague, creating a
clarification loop.

**Fix:** before running any clarifier logic, check whether the last assistant
message in `conversationHistory` ended with `?`. If it did, the user is answering
a question — skip the clarifier entirely, regardless of message length or content.

Also kept the phrase/pattern guards as a defence-in-depth layer, and added
`looksLikeMultiSelect` for "1 and 2" / "1, 2" patterns.

Files changed:
- `bin/smallcode.js` — `assistantAskedQuestion` context guard added as first condition
- `src/session/clarify.js` — updated docblock to document the context-aware guard

---

## [0.9.7] - 2026-05-21

### fix: clarifier + router + LM Studio reasoning fields

- Clarifier instruction now spliced out after one turn (no more lingering system prompt)
- Added path/option-ref/affirmation guards to skip clarifier on actionable short inputs
- Router affirmation guard extended to option-references (`work on 2`) with `shouldKeepCategory`
- Thinking/reasoning fields gated by model name pattern — Gemma gets a clean body, Qwen3/o1/etc get full reasoning fields

---

## [0.9.3] - 2026-05-21

### MarrowScript Features Rank 2–8

Eight new MarrowScript features implemented across the core agent loop,
plus 100 deep analysis passes resulting in 10 real bug fixes.

#### Rank 2: code_intel tool category
New `code_intel` category in `src/compiled/tool_router.js`. Detects "how does X work",
"what calls Y", inheritance, callers, and call-graph questions. Routes to
`[graph_search, explain_symbol, read_file, find_files, search]`. Added to PRIORITY
array before `search` for tie-breaking.

#### Rank 3: verify_and_fix module
New `src/compiled/features/verify_and_fix.js` encapsulates the improvement loop
previously inline in `smallcode.js`. Handles: self-critique, runValidation, fix
prompts, decompose, escalation, auto-rollback. Falls back to inline logic if
module unavailable.

#### Rank 4: error_diagnosis prompt
New `error_diagnosis` template in `src/compiled/features/prompts.js` (TTL 5m).
Exported as `diagnoseError()` from `bin/features_adapter.js`. Wired into
`executor.js` bash case (both persistent shell and execSync fallback): on non-zero
exit, calls `diagnoseError` and prepends a structured hint `[ERROR-DIAGNOSIS]` to
the tool result so the model has typed, located, and actionable error info.

#### Rank 5: decompose_task prompt
New `decompose_task` template (TTL 5m). Exported as `decomposeTask()`. Replaces
the two `pickDecomposeStrategy()` calls in the `smallcode.js` improvement loop
with an LLM-based strategy selector. Falls back to the regex governor on model
unavailability.

#### Rank 6: multi_file_edit coordination
New `src/compiled/features/multi_file_edit.js`. Exported as
`coordinateMultiFileEdit()`. When the model edits 3+ files in a single turn,
injects a `[MULTI-FILE-EDIT]` coordination header listing all files so the model
doesn't drift. Opens a snapshot checkpoint for the edit group. De-duplicates
via recent-history scan.

#### Rank 7: semantic_merge prompt
New `semantic_merge` template (TTL 1m, content-specific). Exported as
`semanticMerge()`. Wired into `executor.js` patch case: when `old_str not found`,
calls the model to merge the intended change into the current file content before
returning the error. Result is ANSI-stripped before writing to disk.

#### Rank 8: adaptive_model_select
New `src/model/adaptive_router.js` — `AdaptiveModelRouter` class + singleton
`getAdaptiveRouter()`. Tracks per-model failure rates (fails/calls). Wired into
`chatCompletion` in `smallcode.js`: overrides `body.model` when failure rate > 0.6
(uses `SMALLCODE_MODEL_STRONG`) or > 0.3 (uses `SMALLCODE_MODEL_MEDIUM`).
Requires at least 3 calls before routing decisions kick in. Records success/failure
after each API response.

### Bug fixes from 100 deep analysis passes

1. **Variable shadowing** — `result` variable in the decompose wiring in
   `smallcode.js` (both file and bash paths) shadowed the outer tool-call `result`.
   Renamed to `decomposeResult`.

2. **Dead code / logic error** — `mergeAttempted` flag in `executor.js` patch case
   was initialized `false` and never set `true`, causing the fallback error message
   to always show. Simplified to a single try/catch with direct early return.

3. **Wrong MCP method** — `context_retriever.js` called `mcpCall('graph_walk', ...)`
   (non-existent method) instead of `mcpCall('tools/call', { name: 'search_graph' })`.
   The context retriever silently returned empty results for every user message.

4. **Wrong MCP response format** — Same file parsed the raw response as a plain
   string instead of extracting `content[].text` from the MCP `tools/call` envelope.

5. **Unsafe JSON.parse in Anthropic escalation** — `escalation.js`
   `_callAnthropic()` called `JSON.parse(tc.function.arguments)` inside a `map()`
   callback without try/catch. Invalid arguments from small models could throw
   uncaught and crash the escalation flow.

6. **Stale hardcoded MCP version** — `mcp_bridge.js` sent `version: '0.4.19'`
   (old version) in the MCP `initialize` handshake. Fixed to read from
   `package.json`.

7. **Stale hardcoded TUI version** — `tui.js` `renderWelcome()` displayed
   `v0.1.0`. Fixed to read from `package.json`.

8. **Redundant require inside loop** — `smallcode.js` improvement loop called
   `const fs = require('fs')` and `const path = require('path')` inside the
   hot path despite both being required at module top. Removed.

9. **Missing ANSI sanitization on model-generated file content** — `executor.js`
   semantic merge wrote the model's returned file content directly to disk without
   stripping ANSI codes. Fixed with `stripAnsi`.

10. **Missing error_diagnosis in execSync fallback** — The `diagnoseError` hint
    was only injected in the persistent shell path, not the `execSync` fallback.
    Now both paths call `diagnoseError` on non-zero exits.

### Benchmark
- Smoke: 5/5 (100%)
- Polyglot-mini: 19/19 (100%)



### Large file write corruption fix (root cause)

The `json.exception.parse_error.101` llama.cpp 500 error when writing large
JSX/React files is now fully resolved:

- `write_file` hard-capped at 8KB / ~60 lines — returns a chunking strategy
  hint instead of silently corrupting
- New `append_file` tool: build large files in chunks without hitting the JSON
  parse limit. Write a skeleton with `write_file`, fill sections with `append_file`
- `create_and_run` now has the same 8KB guard
- System prompt explicitly tells the model to use skeleton + append pattern for
  files over 60 lines
- Regex fallback extractor retained as last resort on JSON.parse failure

### MarrowScript Feature #1 — Compiled intent clarifier

`checkNeedsClarification()` in `bin/features_adapter.js` replaces the hand-rolled
regex in `src/session/clarify.js` with a compiled LLM classifier from
`src/compiled/features/prompts.js`:
- Cached 30 min by message hash — repeated identical vague prompts are instant
- Only fires on messages under 80 chars (no latency overhead on detailed prompts)
- Falls back to regex on model unavailability — never blocks

### MarrowScript Feature #2 — Compiled commit message generator

`generateCommitMessage()` in `bin/features_adapter.js` replaces the
`smallcode: <truncated task>` string in the auto-commit block with a proper
conventional commit message:
- Format: `feat:|fix:|chore:|docs:` prefix validated, under 72 chars
- Cached 1h by task hash
- Falls back to truncation on model failure

### Community
- CJK/wide character cursor position fix in TUI input (PR #25 by @nashixiong926)

## [0.9.0] - 2026-05-21

### Feature #17 — Smart File-Tree Pruning

New module `src/tools/file_tree.js`. `find_files` without a glob pattern and
the `list_projects` fallback now use scored file ranking instead of dumping
everything. On large repos (1000+ files), this prevents the model from
receiving an unusable wall of filenames.

Scoring: +3 modified <24h, +2 modified <7d, +2 source extension, +1 config
file, +1 test file, -2 generated output, keyword bonus from task hint.
Default cap: 50 files. Skips `node_modules/`, `dist/`, `__pycache__/` etc.
Allows `.marrow` directories (MarrowScript source).

Configure: `SMALLCODE_FILETREE_MAX`, `SMALLCODE_FILETREE_SORT=mtime|score`.

**Audit fixes:** eliminated double directory walk in `formatSmartListing`;
`.marrow` directories no longer skipped by dot-prefix filter.

### Feature #16 — Diff-Based Context

New module `src/session/file_state.js`. When `SMALLCODE_DIFF_CONTEXT=true`,
`read_file` returns a unified diff instead of full content when the model has
already read the file this session:

- First read: full content (as before)
- Re-read, unchanged: one-line note — no tokens wasted
- Re-read, changed: compact unified diff with 3 lines of context per hunk
- Fallback to full if diff exceeds 70% of content size (configurable)
- Files > 2000 lines skip the O(n²) LCS computation entirely
- `write_file` and `patch` update the tracker so subsequent reads see fresh state
- Default OFF (`SMALLCODE_DIFF_CONTEXT=false`) — opt-in; no impact on existing behavior

**Bugs fixed during audit:**
- `buildHunk` computed wrong `newStart` for deletion-first hunks (off by actual position)
- No zero-division guard when content is empty
- No size guard on O(n×m) DP table — could OOM on large files (now capped at 2000 lines)
- Test expectation wrong: diff of tiny 5-line file always exceeds ratio threshold due to
  header overhead — corrected test to use 30-line file

### Feature #15 — Multi-Model Chaining

New module `src/model/chain.js` enables a forward-chaining pipeline where
different models handle different stages of the same task:

```
1B classifier → 4B planner → 8B executor
```

- **Planner call** fires concurrently with task classification (zero added
  latency on the critical path). Produces a numbered plan injected as a
  system message before the first `chatCompletion` call.
- **Executor override** — when `SMALLCODE_CHAIN_EXECUTOR` is set, the main
  chat completion uses that model name instead of `config.model.name`.
- Falls through silently if the planner is unavailable or times out (15s limit).
- Complexity guard: fast tasks (rename, explain, typo fix) skip the planner.
- Planner injection is removed from `conversationHistory` at turn end.
- Chain config is cached after first read — no repeated env-var lookups.

Configuration:
```
SMALLCODE_CHAIN=true
SMALLCODE_CHAIN_PLANNER=gemma-2b          # cheap planner model
SMALLCODE_CHAIN_EXECUTOR=qwen3-8b         # main executor
SMALLCODE_CHAIN_PLANNER_URL=http://...    # optional separate endpoint
SMALLCODE_CHAIN_EXECUTOR_URL=http://...
```

**Audit fixes:**
- Used dynamic `import('node-fetch')` which fails on ESM-only v3; switched to
  `globalThis.fetch` (native Node 18+) with `require('node-fetch')` v2 fallback
- Redundant `estimateComplexity` check inside `callPlanner` removed; caller
  guards before starting the promise
- Stale `require('./router')` import removed from chain.js (unused after refactor)

### Feature #14 — Prompt Cache Splitting

Moves query-dependent context (memory, knowledge, skills) out of the system
prompt and into a `<sc:context>` block prepended to the latest user message
when `SMALLCODE_CACHE_SPLIT=true`. The system prompt becomes stable across
turns — remote APIs with prefix caching (Anthropic, OpenAI) can now cache the
static portion instead of re-processing it every turn.

- Default: OFF (legacy behaviour, everything in system prompt)
- Enable: `SMALLCODE_CACHE_SPLIT=true`
- Plan anchor, plugin prompts, and test runner stay in system prompt (authoritative/stable)
- Memory, knowledge, skills move to `<sc:context>` prepended to user message
- `<sc:context>` block is ANSI-stripped before injection
- Multimodal messages (images) handled — context prepended to first text element
- No impact on non-interactive or local deployments; benefit is at remote APIs

**Audit fixes found during implementation:**
- Plugin prompts incorrectly included in dynamic block (moved back to system)
- Plan step instructions incorrectly included in dynamic block (moved back to system)
- Multimodal last-user-message silently dropped context — now prepended to first text element
- Dynamic block not ANSI-stripped before injection — fixed
- `<context>` tag could clash with user-pasted XML — changed to `<sc:context>`

## [0.8.0] - 2026-05-21

### Bug Audit — Features 7-13

Deep static analysis pass found 7 bugs. All fixed and verified.

**Bug 1 — Adaptive temp summed stale improvementAttempts entries**
`Object.values(improvementAttempts)` included non-numeric `__history:*` and
`__decompose:*` meta-keys. The `filter(typeof v === 'number')` caught some but
not `NaN` from failed `parseFloat` on arrays. Changed to `Object.entries` with
explicit `!k.startsWith('__')` guard and `typeof v === 'number' && v > 0`.

**Bug 2 — Trust decay not reset per runAgentLoop turn**
`resetTrustDecay()` was only called in the `runNonInteractive` cleanup block.
In TUI mode, decay accumulated across all unrelated user requests in a session.
A tool failing 5 times spread across 10 separate prompts would be permanently
dropped. Fixed: `getTrustDecay().reset()` now called at the start of each
`runAgentLoop` invocation.

**Bug 3 — Snapshot note() containment check rejected all bench-task paths**
`getSnapshotManager()` singleton was built with the process cwd (SmallCode root)
at first construction, then reused across bench runs in different temp dirs.
`note(absolutePath)` then triggered the containment check (`rel.startsWith('..')`)
because `path.relative(smallcodeRoot, /tmp/bench-xyz/foo.txt)` starts with `..`.
Every snapshot was silently dropped. Fixed by making `getSnapshotManager` return
a new instance when `workdir` differs from the cached singleton's workdir.
`executor.js` now passes `{ workdir: cwd }` to `getSnapshotManager`.

**Bug 4 — Plan request instruction persisted in conversationHistory**
The one-shot system message "write a numbered plan first" was pushed to
`conversationHistory` and never removed. On every subsequent `chatCompletion`
call within the same turn the model saw "write a plan first" again, causing
re-emission of plans. Fixed: recorded `_planInstructionIdx` at push time;
after the first successful `ingestResponse`, splice the instruction out of
history. Applied at both ingestion sites (tool-call path and text-only path).

**Bug 5 — Knowledge loader singleton used SmallCode root for all workdirs**
`getKnowledgeLoader({ rootDir: process.cwd() })` built a singleton against the
SmallCode project root on first call. Bench tasks in temp dirs then received
SmallCode's own `knowledge/` notes injected into their context. Fixed: added
`_knowledgeLoader` to the per-run module-level vars, re-created at each
`runAgentLoop` alongside `_bootstrapDetector` and `_testRunnerDetector`.

**Bug 6 — DELTA=0 env override silently ignored**
`parseFloat('0') || 0.15` = `0.15` — explicit zero was treated as falsy.
Changed to `process.env.SMALLCODE_TEMP_DELTA !== undefined ? parseFloat(...) : 0.15`.
Same fix applied to SMALLCODE_TEMP_MAX and SMALLCODE_TEMP_MIN.

**Bug 7 — Plan formatForPrompt showed no current-step marker when all steps done**
When `currentStep === plan.length`, the `→` marker loop never fired (loop bounds
`i < plan.length` but `currentStep === plan.length`). Every step showed `' '`.
Fixed: detect all-complete state explicitly, show `COMPLETED PLAN` header instead
of `ACTIVE PLAN (step N of N)`, suppress the "Work on current step" hint.

### Verified
- 14/14 bug-fix unit checks green
- Smoke benchmark: 5/5 passing
- **Polyglot-mini benchmark: 19/19 (100%)** — up from 17/19 (89%) pre-fix
  (`js-arrow` and `sh-script` now passing)

### Features 10-13 Added

- **Feature 10 — Test-runner auto-discovery** (`src/tools/test_runner.js`):
  Detects test runner from project config (package.json scripts, devDeps,
  pytest.ini, pyproject.toml, Cargo.toml, go.mod, pom.xml, build.gradle,
  .rspec, .sln). Injects `Test runner (framework): \`cmd\`` into system
  prompt once per run. Also injected into AUTO-VALIDATE fix prompts so
  model knows how to verify its own fixes. Disable with
  `SMALLCODE_TEST_DISABLE=true`. Override with `SMALLCODE_TEST_RUNNER=<cmd>`.
  Re-built per agent run (not a singleton) so bench tasks in temp dirs
  get the correct info for their workspace.

- **Feature 11 — Bootstrap detection** (`src/session/bootstrap.js`):
  Scans workspace on first turn and injects a 1-2 line project summary:
  runtime + version (.nvmrc / .python-version / .tool-versions), package
  manager, framework (Next.js/FastAPI/Express/Django/…), entry point,
  and build/test/run scripts. Keeps small models from spending 3-5 tool
  calls just to learn the project layout. Detects Node, Python, Rust, Go,
  .NET, Java (Gradle/Maven), Ruby. Disable with `SMALLCODE_BOOTSTRAP=false`.
  Re-built per agent run (not a singleton) to pick up correct workdir.

- **Feature 12 — Adaptive retry temperature** (`src/model/adaptive_temp.js`):
  On improvement-loop retries, nudges the temperature so each attempt
  explores differently: attempt 1 goes lower (deterministic fix), attempt 2
  higher (explore alternatives), attempt 3 back to base. Controlled by
  DELTA=0.15 default, clamped to [MIN, MAX]. No-op when body has no
  temperature field. Disable with `SMALLCODE_TEMP_ADAPT=false`.

- **Feature 13 — Per-tool trust score decay** (`src/tools/trust_decay.js`):
  Tracks consecutive failures per tool within a session. Tools that fail
  N ≥ 3 times in a row are soft-demoted (moved to back of schema list);
  N ≥ 5 failures drops them from the schema entirely for that session.
  Any success resets the failure counter. Prevents the model from looping
  on a broken MCP tool or a search that keeps returning nothing useful.
  Trust state resets between agent runs. Disable with
  `SMALLCODE_TRUST_DECAY=false`.

### Verified
- 15/15 unit tests (test runner) + 13/13 (bootstrap) + 9/9 (adaptive temp) + 10/10 (trust decay)
- Smoke benchmark: 5/5 passing
- Polyglot-mini benchmark: 17/19 (89%) — 2 failures are model/environment
  limitations (Windows shell scripts, tight regex) not code regressions

### Bug fixed (during features 10-11)
- Bootstrap and test-runner detectors were using `getXxx()` singletons built
  against the SmallCode project root, then cached for all agent runs. Bench
  tasks running in temp dirs would receive SmallCode's own pytest/node test
  config injected. Fixed by building fresh instances per `runAgentLoop` call
  bound to `process.cwd()`.

### Feature 9 Added — Snapshot & Auto-Rollback

- **`src/session/snapshot.js`** `SnapshotManager`: checkpoint-style grouping
  of file edits that can be rolled back as a unit.
  - `begin(label)` opens a checkpoint. `note(path)` records pre-edit content
    (first-snapshot-wins). `rollback(reason)` restores all files to their
    pre-checkpoint state (new files deleted, existing files restored).
    `commit()` discards the checkpoint without touching files.
  - Wired into `executor.js` `write_file` and `patch` — every edit auto-notes
    the file when a checkpoint is open.
  - Wired into `runAgentLoop`: `begin()` at turn start, `commit()` at clean
    end, `rollback()` at escalation-exhausted branch when
    `SMALLCODE_SNAPSHOT_AUTO_ROLLBACK=true`.
  - Containment: refuses to snapshot paths outside `workdir`.
  - Persistence: checkpoint metadata (not file content) written to
    `.smallcode/snapshots/<id>.json` for audit / manual rollback.
  - Singleton reset added to `runNonInteractive` cleanup.
  - Disable with `SMALLCODE_SNAPSHOT=false`.
  - Manual rollback available via opt-in env flag; does not affect normal
    flow — all existing smoke tests still 5/5.

### Verified
- 16/16 unit tests for SnapshotManager
- Smoke benchmark: 5/5 passing

### Feature 8 Added — Plan-Then-Execute Mode

- **`src/session/plan_tracker.js`**: For multi-step tasks, asks the model to
  emit a numbered plan FIRST (before any tool calls), then re-injects that
  plan as an anchor in subsequent turns. Heuristic-based — single-shot
  tasks like "create hello.py" don't trigger planning to avoid latency.
  - Triggers: messages > 300 chars, multi-step keywords (refactor/migrate/
    implement+feature), or 3+ sentences with length > 150 chars.
  - Plan parser handles numbered (`1. step`), bulleted (`- step`), and
    fenced markdown formats. Continuation lines merged conservatively.
  - On subsequent turns, system prompt gets `ACTIVE PLAN (step N of M):`
    block with `✓` / `→` / ` ` markers per step.
  - Auto-advance regex matches "step N done", "step N: complete",
    "Step N. finished", "step N ✓" etc.
  - Tracker resets per agent run; never leaks state across tasks.
  - Configurable: `SMALLCODE_PLAN=true|false` (force/disable),
    `SMALLCODE_PLAN_MIN_STEPS=2`, `SMALLCODE_PLAN_MAX_STEPS=8`.

### Verified
- 21/21 unit tests for plan tracker
- E2E multi-step refactor task (utils.py + main.py + test_utils.py +
  unittest run): all 3 files correct, tests pass
- Smoke benchmark: 5/5 still passing

### Bug fixes (during plan-tracker integration)
- Tightened `shouldPlan` heuristic — was over-triggering on short
  3-sentence prompts like fix-typo. Now requires length > 150 chars
  for the 3-sentence rule.
- Strengthened plan-request instruction to explicitly say "do NOT stop
  after writing the plan" (was causing models to emit plan and halt).
- Fixed string-vs-template-literal bug in `formatForPrompt` (single-
  quoted string contained literal `${cur}` instead of interpolation).
- Tightened plan-line continuation rule — only merges short lowercase
  fragments without trailing punctuation, not full sentences.

### Feature 7 Added — Evidence Store

- **`src/memory/evidence.js`**: Automated capture of "what was tried, what
  worked, what failed" per task. Stored in the existing memory MCP module
  (budget-aware-mcp) under `type: 'context'` with `tag: 'evidence'` so it
  flows through the existing `loadForTask` FTS5 + staleness-decay path
  rather than hogging the live system prompt. Surfaces only when relevant
  to the current task.
  - Summarizes `TraceRecorder` output into a 1-3KB digest: failed/successful
    steps, files edited, validation outcomes, duration.
  - Smart error-tail extraction prefers specific named errors (ImportError,
    SyntaxError, Traceback) over generic ones (Exit code N).
  - Adjacent step deduplication (`patch foo.py (×3)` not 3 lines).
  - Tags: `evidence`, plus outcome class (`success` / `partial-failure` /
    `validation-failed`).
  - Disable with `SMALLCODE_EVIDENCE_DISABLE=true`.
  - Falls back to positional `remember(type, title, content, opts)` when
    object-form fails (compatibility with local `bin/memory.js` store).

### Verified
- 14/14 unit tests for evidence summarization
- E2E: SmallCode run produces `.memory/context-*.md` with correct evidence
  tags, file list, and step summaries
- Smoke benchmark: 5/5 passing with evidence active

### Features 4-6 Added

- **Feature 4 — Knowledge injection** (`src/knowledge/loader.js`): Drop reference
  notes into `knowledge/` directory and the most relevant ones get injected
  into the system prompt based on keyword overlap with the user's message.
  Per-message budget cap (1500 tokens default), per-entry cap (1500 chars).
  Front-matter `keywords:` overrides path-based inference. Configurable via
  `SMALLCODE_KNOWLEDGE_DIR`, `SMALLCODE_KNOWLEDGE_MAX_TOKENS`,
  `SMALLCODE_KNOWLEDGE_DISABLE`. Sample notes added under `knowledge/`.
- **Feature 5 — Read-before-write guard** (`src/tools/read_tracker.js`):
  Tracks which paths the model has read this session. First `write_file` to
  an existing unread file is refused with a hint; second attempt allowed
  (so legitimate full-replace intents succeed). New files always allowed.
  `patch` counts as read (it requires `old_str` matching). Configurable via
  `SMALLCODE_WRITE_GUARD=false` (off) or `SMALLCODE_WRITE_GUARD_STRICT=true`
  (hard block).
- **Feature 6 — Tool-call deduplication** (`src/tools/dedup.js`): Identical
  pure-tool calls within a sliding window (default 5) are short-circuited
  with a cached result. Only applies to read-only tools (`read_file`,
  `search`, `graph_search`, `memory_load`, etc.) — never to anything with
  side effects. Errors are not cached. Argument-key-order independent.
  Configurable via `SMALLCODE_DEDUP=false` and `SMALLCODE_DEDUP_WINDOW=N`.

### Verified
- Smoke benchmark: 5/5 passing with all six features active
- 18 unit checks for features 4-6 green
- 10 audit unit checks for features 1-3 green

### Audit & Bug Fixes — Features 1-3 (Persistent Shell, Thinking Budget, Bench Harness)

Audit pass after rolling out the three new features. 10 bugs found and fixed.

### `src/tools/shell_session.js` — Persistent Shell Session
- **Process exit listeners no longer double-register** — `process.on('exit'/'SIGINT'/'SIGTERM')`
  fired at module load. With `delete require.cache` (used by the test suite)
  the same module re-required would stack a fresh set of listeners every time.
  Guarded behind a `global.__SMALLCODE_SHELL_EXIT_REGISTERED__` flag.
- **`cd` containment now catches all escape vectors** — Old regex
  `/^\s*cd\s+(\S+)/` matched only top-of-line, naked `cd`. The model could
  bypass with `cd "../"`, `pushd ..`, `chdir ..`, `; cd ..`, or `&& cd ..`.
  Now iterates every `cd|pushd|chdir` in the command and simulates the cwd
  through chained calls.
- **Sub-shell escape outright refused** — `bash -c "cd .."`, `sh -c '...'`,
  `pwsh -c '...'` etc. bypass our wrapper because the inner shell's cwd
  changes don't survive. Now refused with explicit message when
  `SMALLCODE_SHELL_CONTAIN=true`.
- **Windows timeout actually kills the command now** — Previous code wrote
  `\r\n` to stdin which does nothing to a hung command. Now SIGKILLs the shell
  process and resets it. The next command spawns a fresh shell. Half-measures
  left the buffer in indeterminate states and the sentinel never arrived,
  hanging the queue forever.
- **`_drain` is now iterative** — Was recursive (`if (queue.length > 0) this._drain()`),
  could stack-overflow when many sentinels arrived back-to-back. Converted to
  a `while` loop.
- **Buffer truncation no longer slices mid-sentinel** — Hard cap kicks in at
  4× `maxOutputBytes`. Old truncation `slice(-maxOutputBytes * 2)` could chop
  a sentinel mid-string, causing the head command to never resolve. Now
  preserves recent sentinel boundaries.

### `src/model/thinking_budget.js` — Thinking Budget Control
- **`applyThinkingBudget` no longer mutates caller's options** — When
  `SMALLCODE_THINKING_DISABLE=true`, the function set `options.disable = true`
  on the caller's object. Subsequent calls (or callers reusing the options
  object) saw the leaked mutation. Now copies options internally.

### `bench/harness.js` — Benchmark Harness
- **Process group orphaning fixed** — On Linux/macOS, `child.kill()` only
  killed the Node entry, leaving spawned child processes (e.g. the persistent
  shell's `bash`) alive. Now spawns with `detached: true` and `process.kill(-pid, 'SIGKILL')`.
  On Windows uses `taskkill /T /F` to kill the whole tree.
- **Tool-call counter no longer fooled by ANSI** — `⚙` could be preceded by
  ANSI color codes (`\x1b[2m⚙ `) on systems that ignore `NO_COLOR`. Now strips
  ANSI before counting and explicitly sets `NO_COLOR=1` and `FORCE_COLOR=0`
  in the child env.
- **Timeout now reported in result** — `timedOut: true` flag added so callers
  can distinguish "model gave up" from "harness killed it".

### Verified
- Smoke benchmark: 5/5 passing (`huihui-gemma-4-e4b-it-abliterated`)
- All 10 audit unit checks green
- Modules pass `node --check`

## [0.7.1] - 2026-05-20

### Security
Audit pass focused on context-leak-through-tooling. 21 issues fixed across the
session, tools, MCP, and provider layers.

### Tool Schema & Definition Fixes (Round 3)
- **`src/compiled/tool_router.js`** — `search` and `plan` categories referenced
  phantom tool name `'grep'` (actual name is `'search'`). All categories now
  map to correct tool names, include compound tools, and cover `explain_symbol`,
  `memory_load`, `memory_remember`, `bone_compile`, `bone_check`.
- **`bin/tools.js`** — Added missing tool definitions for `web_search`,
  `web_fetch`, `memory_list`, `memory_forget`. These had executor support but
  no schema — the model could never call them. Added `required: []` to
  `list_projects` (some servers reject missing `required` field).
- **MCP server mode** (`handleMCPToolCall`) — Fixed path traversal in
  `smallcode_read_file` and `smallcode_patch` (used raw `path.resolve` with no
  containment). Fixed shell injection in `smallcode_search` (interpolated
  pattern into shell string). Fixed `smallcode_bash` (no blocklist). Fixed
  `smallcode_memory_load` crash (destructured `{objects}` from a plain array).
  Fixed `smallcode_memory_remember` calling wrong `memoryStore.remember` API.
  All now use `safeResolvePath` + `escapeShellArg` + `sanitizeToolOutput`.
- **MCP server mode** — `runMCP` and `handleMCPRequest` are now async.
  `smallcode_agent` tool previously returned before the agent loop finished
  because the handler wasn't awaited. Now awaits properly.
- **Duplicate `runValidation`** — Removed the 80-line inline version in
  `smallcode.js` (which still used shell-interpolated paths) and replaced with
  a one-liner delegating to `model_client.js`'s hardened `execFileSync` version.
- **`bin/executor.js` `memory_load`/`memory_remember`** — Now handles both the
  budget-aware-mcp API (object arg, `{objects}` return) and the fallback
  `MemoryStore` (positional args, array return) without crashing.
- **`src/lsp/client.js`** — `getDiagnostics` now sends `textDocument/didClose`
  after reading diagnostics so the language server doesn't hold every validated
  file in memory forever. Prevents TS server OOM on long sessions.
- **`src/tools/builtin/web_browse.js`** — Added `process.on('exit'/'SIGINT'/'SIGTERM')`
  handlers that close the Playwright browser instance. Previously leaked a
  100-300MB Chromium process for the entire session lifetime.
- **LSP client cleanup** — Added `_lspClient.stop()` to the TUI close handler
  (previously the language server process leaked as a zombie on exit).
- **`bin/governor.js`** — `verificationHistory` now bounded to 50 tracked files.
  Oldest entries are pruned when the limit is reached. Previously grew without
  bound across all turns.
- **Session ID generation** — Old formula `(9999999999999 - Date.now())` would
  overflow in 2033 producing `NaN` IDs and session collisions. Replaced with
  `MAX_SAFE_INTEGER - Date.now()` (good until year 2255).

### Context Overflow Fixes (20 bugs)
- **Mid-turn eviction loop** — `midEst` was a `const` that never decreased; the
  loop evicted everything or nothing. Now uses `let` and decrements on each eviction.
- **Mid-turn eviction orphans tool_call_ids** — splicing `role:"tool"` messages
  breaks the tool_call pairing. Now replaces content with `[evicted: N tokens]`
  when the assistant message is still present; only splices truly orphaned entries.
- **Improvement loop injects full file content unbounded** — capped to 15% of
  context window (max 8000 chars). Escalation prompt also capped to 12000 chars.
- **`[AUTO-FIX]` bash error injection** — reduced from 1500 to 800 chars per
  attempt. The full output already lives in the tool result message.
- **`[SEMANTIC-REVIEW]` never evicted** — no direct fix (these are `role:'user'`)
  but the combination of tighter compaction triggers and lower thresholds means
  compaction fires earlier and removes them along with other old messages.
- **`[DECOMPOSE]` strategy instructions unbounded** — capped indirectly by the
  tighter compaction trigger (now fires at 80% of budget, not 100%).
- **Image base64 re-extracted on every `chatCompletion` call** — now only extracts
  from the most recent user message. Older @image references are treated as plain text.
- **`formatReferencesForPrompt` no size cap** — capped at 8000 chars (~2000 tokens).
  Individual files capped at 4000 chars. Excess files noted as truncated.
- **Git diff `--stat` output unbounded** — capped at 40 lines.
- **Auto-compact fires only at 30+ messages OR 100% token overflow** — now fires
  at 80% token usage regardless of message count. Small-context models (8k-16k)
  need early compaction.
- **Compression target was 10% of window** — bounded to max 1500 tokens. A 128k
  model doesn't need a 12,800-token summary.
- **Tool schemas sent without context awareness** — 2-stage routing now returns
  ONLY the category selector (not selector + all tools). Small-context models
  (<16k) always use pure 2-stage.
- **Assistant tool_calls store full `write_file` content in history** — arguments
  now truncated to 500 chars in the stored message. The tool result already
  confirms what was written.
- **Memory injection with no relevance threshold** — now caps at 3200 chars and
  scales with context window (3% of detected window).
- **Auto-commit shell injection via commitMsg** — migrated to `execFileSync` with
  arg arrays. Special chars in commit messages no longer break the shell.
- **Plugin prompt injections unbounded** — capped at 2000 chars.
- **Skill auto-injection unbounded** — capped at 4000 chars.
- **Fallback compaction stops at 20 messages even if over budget** — removed the
  `conversationHistory.length <= 20` bail condition.
- **`currentToolCategory = null` after first tool call** — changed to `'plan'`
  which gives all tools without also adding the category selector on 2-stage.
- **2-stage routing returns `[selector, ...allTools]`** — now returns only
  `[selector]` as originally intended (the whole point of 2-stage is to NOT
  send all tools upfront).

### Added
- `src/security/sanitize.js` — Single source of truth for redaction, ANSI
  stripping, path containment, and shell escaping. ~280 lines, no I/O.
  - `redactString` / `redactValue` — Strip OpenAI/Anthropic/GitHub/Google/AWS
    keys, JWTs, bearer tokens, env-style `KEY=value` pairs, and PEM private
    key blocks. Cycle-safe via `WeakSet`.
  - `safeResolvePath` — Containment-checked path resolution; refuses
    traversal, sensitive paths (`.ssh`, `.aws`, `/etc/shadow`, etc.), absolute
    paths, NUL bytes. Optional `allowHome` / `allowOutside` flags.
  - `escapeShellArg` / `buildCommand` — Cross-platform safe shell escaping;
    POSIX single-quote and Windows double-quote-with-doubling. Used to
    eliminate every `"${userInput}"` interpolation in shell commands.
  - `stripAnsi` — Comprehensive ANSI/control stripper covering CSI, OSC,
    DCS, SOS, PM, APC, 8-bit C1, and stray C0 controls. Replaces the
    previous CSI-only `\x1b\[…[a-zA-Z]` regex which left OSC and 8-bit
    sequences intact in tool output.
  - `sanitizeToolOutput` — Combined ANSI strip + secret redaction for any
    string flowing back into the model's context window.
  - `createLineDemuxer` — Shared 'data' listener for stdio JSON-RPC clients
    that demuxes line-by-line into per-request handlers. Replaces the
    per-request `on('data', …)` pattern in MCP clients.

### Changed (security fixes)
- **`src/session/persistence.js`** — Sessions now redact secrets before
  writing to disk, use atomic temp+rename writes, enforce 0o600 file mode
  and 0o700 dir mode, and validate session IDs against `^[A-Za-z0-9_-]{1,64}$`
  to block path traversal via crafted IDs (e.g. `load('../../../etc/passwd')`).
- **`bin/trace_recorder.js`** — Redacts tool args, tool results, model
  responses, and prompts before persisting. Validates trace IDs. Atomic
  writes with 0o600 mode. Generated test files use `JSON.stringify` for
  string literals to prevent injection from crafted commands.
- **`src/session/references.js`** — `@path` resolution is now containment
  checked; sensitive paths are silently dropped; file content is sanitized
  before injection so `@.env` doesn't leak API keys to the model. Files
  >5MB are refused.
- **`src/session/images.js`** — Image references are containment-checked
  and refused over 8MB to prevent base64 context blow-up.
- **`src/session/share.js`** — Replaced `execSync` shell-string with
  `execFileSync` array form (the prior code interpolated session title
  into a shell command — a crafted title could escape the quoting).
  Temp file moved to OS tmpdir with 0o600 perms. Output redacted.
- **`src/session/git_context.js`** — Migrated from `execSync` to
  `execFileSync` with arg arrays. Output sanitized.
- **`src/tools/mcp_client.js`** — Strips ambient API keys (`OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, etc.) from the env passed to spawned MCP servers
  unless the server's config explicitly re-exports them. Replaced the
  per-request `on('data', …)` pattern with a single shared line demuxer
  (the prior pattern leaked listeners under load and could resolve a
  request with another request's bytes).
- **`bin/mcp_bridge.js`** — Same demuxer fix; `shell: false` made explicit
  on the spawn; demuxer cleaned up on process exit and `killMCP()`.
- **`src/tools/builtin/web_browse.js`** — `webFetch` validates URLs through
  the SSRF guard; refuses loopback / RFC1918 by default; uses
  `redirect: 'manual'` so a 30x to `169.254.169.254` can't bypass the
  guard. Output sanitized.
- **`src/compiled/providers/ssrf_guard.js`** — Allowlist matching now uses
  `URL.origin` rather than naive `startsWith` (the prior approach allowed
  bypass via prefix-spoof URLs like `https://api.example.com.attacker.com`).
  Always-blocked list added for cloud metadata, link-local (169.254/16),
  CGNAT (100.64/10), and 0.0.0.0/8 — even when
  `LLM_ALLOW_PUBLIC_ENDPOINTS=1`.
- **`bin/executor.js`** — `read_file` / `write_file` / `patch` /
  `read_and_patch` / `create_and_run` use `safeResolvePath` instead of
  raw `path.resolve`. `search` / `find_files` / `graph_search` /
  `explain_symbol` / `find_and_read` / `search_and_read` use
  `escapeShellArg` / `buildCommand` instead of `String.replace(/"/g, …)`.
  All tool output flows through `sanitizeToolOutput`. `bone_compile`
  validates the `target` arg against an enum allowlist. The `run` tool's
  timeout error message now reflects the configured timeout instead of
  hard-coded "30s". `explain_symbol` rejects non-identifier symbols.
- **`bin/model_client.js`** / **`bin/governor.js`** — `runValidation` and
  `verifyCode` use `execFileSync` with arg arrays so the file path
  (which the model controls) cannot inject shell commands. Provider
  error messages are redacted before logging.
- **`src/api/index.js`** — `_executeTool` for `read_file`, `write_file`,
  `patch`, `bash`, `search`, `find_files` migrated to safe path resolution
  and shell escaping; tool output sanitized; provider errors redacted.
- **`src/governor/early_stop.js`** — `newTurn()` clears `_patchAttempts`
  in addition to `patchFailures` (the prior version leaked attempt counts
  across turns, eventually causing false-positive patch-spiral signals).

### Fixed
- Tool output containing `\x1b]0;…\x07` (OSC, e.g. terminal title-set from
  TUIs run inside `bash`) was previously injected into the model's
  conversation context as raw bytes. Tools now strip OSC, DCS, and 8-bit
  C1 in addition to CSI.
- `session_persistence._save` was a non-atomic single `writeFileSync`. A
  crash mid-save left a half-written session that the next launch couldn't
  parse and that `list()` then quietly dropped. Atomic temp+rename fixes
  it.
- `mcp_client._sendRequest` attached one `on('data', …)` listener per
  request; under bursty traffic (e.g. tool listing on initialize, then
  many parallel tool calls), the same chunk was re-parsed by every
  outstanding listener, occasionally letting one request resolve with
  another request's bytes. Single demuxer fixes it.
- `web_fetch` followed redirects automatically. A model could hit a
  benign-looking URL that 302-redirected to `169.254.169.254/…` and
  exfiltrate cloud metadata that way. `redirect: 'manual'` blocks it.

## [0.6.9] - 2026-05-20

### Added
- **Features 1-6 Adapter** — `bin/features_adapter.js` wires six MarrowScript-compiled features into the agent loop:
  - Feature 1: `repairToolCall` — LLM self-repair for malformed tool call JSON
  - Feature 2: `summarizeFileCompiled` — Cached LLM file summarization (files >100 lines, 1h TTL)
  - Feature 3: `assertWithinBudget` / `chargeBudget` / `getBudgetState` — In-memory rate-limiting (30 turns/min, 500k tokens/hr)
  - Feature 4: `setApprovalHandler` / `awaitCheckpointDecision` / `submitCheckpointDecision` — TUI checkpoint approval flow
  - Feature 5: `retrieveContext` — Zero-LLM semantic context retrieval via code-graph-mcp walk
  - Feature 6: `validateEditCompiled` — Self-critique after file writes
- **`src/compiled/features/prompts.js`** — Self-contained prompt runner using direct fetch (no full provider stack). Inline templates for `repair_tool_call`, `summarize_file`, `validate_edit`. In-memory SHA-256 cache.
- **`src/compiled/features/policy.js`** — In-memory budget policy (no DB). Sliding window rate limits per turn and per-hour token budget.
- **`src/compiled/features/checkpoints.js`** — In-memory checkpoint flow with TUI approval callback support.
- **`src/compiled/features/context_retriever.js`** — Keyword-based graph walk for semantic context retrieval.
- **`marrow/features_1_6.marrow`** — MarrowScript source declaration for all six features (staged to git).

## [0.6.9] - 2026-05-19

### Added
- **Feature 1: Tool Call Repair** — When the model produces malformed JSON args, the compiled `repair_tool_call` prompt self-repairs instead of silently failing. Sends original call + error + schema back for single-shot correction.
- **Feature 2: File Summarization** — Large files (>200 lines) are automatically summarized to function signatures + key logic via `summarize_file` prompt. 1h TTL cache keyed by content hash. Falls back to full content gracefully.
- **Feature 3: Policy Enforcement** — In-memory sliding window rate limiter: 30 turns/min, 500k tokens/hr. Compiled from `agent_limits` policy in `features_1_6.marrow`. Warns on limit, doesn't hard-block local use.
- **Feature 4: Checkpoint Flow** — `edit_with_approval` flow compiled from MarrowScript. In-memory await/submit system with timeout + auto-approval handler. TUI can hook `setApprovalHandler` for supervised mode.
- **Feature 5: Context Retrieval** — Before each turn, walks code graph from user message keywords (zero LLM calls). Auto-injects relevant file hints into the system prompt. Keyword extractor prefers CamelCase/PascalCase symbols.
- **Feature 6: Self-critique** — After `write_file`/`patch`, asks model "does this look correct?" via `validate_edit` prompt (10m cache). Fails open — never blocks on unavailable model.
- `bin/features_adapter.js` — Unified adapter exposing 11 functions for all 6 features
- `src/compiled/features/prompts.js` — Self-contained prompt runner (direct fetch, in-memory cache)
- `src/compiled/features/policy.js` — In-memory budget policy runtime
- `src/compiled/features/checkpoints.js` — Checkpoint flow runtime
- `src/compiled/features/context_retriever.js` — Keyword extraction + graph walk
- `marrow/features_1_6.marrow` — Source declaration for all 6 features
- `.test-workspace/test_features_1_6.js` — 46-test suite (all passing)

### Changed
- `bin/executor.js` — `read_file` now triggers `summarize_file` for files >200 lines (Feature 2)
- `bin/smallcode.js` — Wired all 6 features: tool repair on parse fail, context retrieval per turn, policy assert/charge, self-critique on writes, rate limit display
- `bin/commands.js` — `/tokens` now shows policy budget state (turns/min, tokens/hr)



### Added
- **Deterministic Tool Router** — Compiled from `marrow/tool_router.marrow` to `src/compiled/tool_router.js`. Classifies user messages into tool categories (read/write/search/run/plan/web/respond) using pure weighted regex — zero LLM calls, zero tokens, zero latency.
- **Per-turn tool filtering** — On each new turn, the router pre-classifies the intent and injects only the relevant tool subset. Saves 71–100% of tool schema tokens per call:
  - `read` → 301 tok (was 1764, -83%)
  - `write` → 334 tok (-81%)
  - `search` → 278 tok (-84%)
  - `run` → 260 tok (-85%)
  - `plan` → 516 tok (-71%)
  - `web` → 97 tok (-95%)
  - `respond` → 0 tok (-100%, no tools injected for pure answer questions)
- **Router confidence display** — Fullscreen TUI shows category + confidence% in the tool panel on each turn.
- **20/20 classification accuracy** on test suite covering shell commands, code edits, search, planning, web lookups, greetings, and debugging questions.

### Changed
- **`getAllTools()`** — Now accepts `currentToolCategory` from the compiled router. Falls back to two_stage_router or all-tools if router unavailable.
- **Tool category resets mid-turn** — After first tool call, tool list widens to full set (model may need different categories mid-turn).
- **`marrow/tool_router.marrow`** — Source declaration for the compiled classifier (gitignored but included in npm package).

## [0.6.7] - 2026-05-19

### Added
- **Token Monitor** — Real-time tracking of prompt/completion tokens per call and per turn. Exposes efficiency metrics (completion:prompt ratio), compaction counts, and eviction counts.
- **`/tokens` command** — Detailed token usage report showing totals, per-call averages, and efficiency.
- **`/budget` command** — Visual context window budget display with usage bar, compaction/eviction stats.
- **Trace Recorder** — Automatically records every agent turn: tool calls, model responses, token usage, validations. Persists to `.smallcode/traces/`.
- **`/trace` command** — List, show, and export execution traces. Supports `list`, `show <id>`, `test <id>`.
- **Trace-to-Test** (`/trace test <id>`) — Generates Jest-compatible test files from recorded traces, asserting file creation and command success.
- **Prompt Evaluation Runner** — Built-in evaluation suites for task classification accuracy, tool selection quality, and response quality.
- **`/eval` command** — Run evaluations in-TUI (`/eval classify_accuracy`, `/eval tool_selection`).
- **`--eval <suite>` flag** — Non-interactive evaluation mode for CI/automation.
- **Bounded Loop Adapter** — Wired MarrowScript-compiled loop runtime into improvement loop for bounded iteration with tracing. Falls back to simple counting when compiled runtime unavailable.
- **`--trace <ID>` flag** — Placeholder for trace replay (documented, future implementation).

### Changed
- **Improvement loop** now tracks validation failures in token monitor and uses bounded loop adapter for iteration control.
- **`/stats` command** now shows token usage summary inline.
- **`/help` command** updated with all new commands (`/tokens`, `/budget`, `/trace`, `/eval`).

### Internal
- `bin/trace_recorder.js` — 160 lines, trace recording + test generation
- `bin/eval_runner.js` — 150 lines, evaluation framework with 3 built-in suites
- `bin/token_monitor.js` — Enhanced with `_nextCallIsNewTurn` pattern for turn boundary detection
- `bin/loops_adapter.js` — Bridges compiled MarrowScript bounded loops into agent
- `bin/commands.js` — Now accepts `tokenMonitor` parameter; 5 new commands added

## [0.6.6] - 2026-05-19

### Fixed
- **Permanent hang after tool calls** — Root cause: `streamFinalResponse` was called after tool calls completed, causing infinite await. Now only streams when `toolCallsThisTurn === 0`. Added 30s timeout as safety net.
- **120s abort timeout** on `chatCompletion` — Prevents permanent hang if model stops responding entirely.

## [0.6.1] - 2026-05-19

### Added
- **MarrowScript Cognition Layer** — Compiled from `marrow/smallcode_cognition.marrow`, generates 1400+ lines of production TypeScript runtime with:
  - Typed prompt callers with retry, timeout, and repair loops
  - Content-hash prompt caching (0ms on cache hit, 10m TTL)
  - Structured trace spans with trace_id/span_id for every LLM call
  - Token budget enforcement per cost class
  - Deterministic tier-based routing (trivial → simple → complex)
  - SSRF guard on all outbound requests
  - Schema validation with repair prompts on failure
- **Phase A: Compiled Task Classifier** — `classifyTask` now uses LLM-backed classification with cache, falling back to regex. Replaces hand-rolled regex-only approach.
- **Phase B: Compiled History Compression** — Semantic summarization of old messages before eviction. Preserves key facts instead of just dropping context.
- **Phase C: Compiled Tier Router** — `coding_router` dispatches to TinyClassifier/SmallCoder/MediumCoder based on complexity score.
- **`/cognition` command** — Shows live status of the MarrowScript cognition layer (loaded models, prompts, routers).
- **Blocking command detection** — Refuses to execute server-start commands (`node server.js`, `npm start`, etc.) that would hang the bash tool for 30s.
- **Mid-turn context eviction** — Every 3 tool calls, checks if history exceeds 60% of context budget and evicts old tool results.
- **19-test stress suite** — Covers file ops, multi-step tasks, code intelligence, improvement loop, error recovery, and governor routing.

### Fixed
- **Context overflow on tool-heavy tasks** — Tool results now capped at 4k chars each (was 12k). Prevents context explosion after 5+ tool calls.
- **Fullscreen response not rendering** — After tool calls, the model's final text response now properly renders via `addChat` instead of swallowed `stdout.write`.
- **Double output in fullscreen TUI** — Removed redundant `addChat` in `onSubmit` handler.
- **Mouse scroll + copy/paste** — Enabled mouse tracking for scroll wheel; `Shift+drag` selects text (shown in status bar).
- **"fetch failed" after bash timeout** — Blocking server commands now refused instead of timing out and corrupting the session.
- **File not found errors** — Path normalization strips `./` prefix, error shows resolved path for model self-correction.
- **list_projects output bloat** — Compacted to one line per project (was 6 lines each).

### Changed
- **Modular architecture complete** — `bin/smallcode.js` split from 2181 → 1570 lines across:
  - `bin/config.js` (165 lines) — Config + endpoint check
  - `bin/mcp_bridge.js` (151 lines) — Code graph MCP
  - `bin/executor.js` (338 lines) — Tool execution
  - `bin/model_client.js` (284 lines) — LLM communication
  - `bin/tools.js` (64 lines) — Tool definitions + routing
  - `bin/cognition_adapter.js` (100 lines) — Bridge to compiled cognition
- **System prompt 90% smaller** — Task-aware compact prompt (~200 tokens) replaces verbose 2k-token version.
- **Default context window** — 128k (was 0/auto-detect that often failed).
- **Cognition logs silent by default** — Set `SMALLCODE_COGNITION_LOG=stderr` to enable structured trace output.

## [0.5.0] - 2026-05-18

### Added
- **Programmatic API** — `const { SmallCode } = require('smallcode')`. Run prompts, subscribe to events, get structured results.
- **MCP Client** — Consume external MCP servers as tool providers. Configure in `.smallcode/mcp.json`.
- **Early-Stop Detection** — Catches repetition loops, patch spirals, and greeting regression automatically.
- **2-Stage Tool Router** — Reduces schema context by ~50% for small-context models (≤16k).
- **Model Profiles** — Auto-detects Gemma/Qwen/DeepSeek/Llama capabilities from model name.
- **`-P` / `--prompt` flag** — Run a single prompt: `smallcode -P "fix the bug"`.
- **`/profile` command** — Shows detected model profile and routing mode.
- **`/mcp` command** — Shows connected external MCP servers.
- **E2E Test Suite** — 10 tests covering math, file ops, patching, search, graph, and architecture prompts.

### Fixed
- **Auth headers in all API paths** — chatCompletion, streamFinalResponse, sendToModel, and startup health check all send `Authorization: Bearer` when API key is configured.
- **OpenRouter support** — Required `HTTP-Referer` and `X-Title` headers added automatically.
- **`/escalation` command crash** — `escalationEngine` was out of scope in command handler.
- **`-v` flag collision** — `-v` is version, `-V` is verbose.
- **VERSION constant** — Aligned across all files.
- **Auto-compact preserves system messages** — Skills and plugin injections no longer evicted.
- **"Exit code undefined"** — Properly reports timeout instead of undefined.
- **Native deps optional** — `better-sqlite3` moved to optionalDependencies. Install no longer needs C++ build tools.
- **Patch spiral recovery** — After 4 failed patches, forces `write_file` rewrite instead of infinite loop.
- **Streaming repetition detection** — Halts generation when model repeats itself.

### Changed
- **Modular architecture** — Monolithic `bin/smallcode.js` (2181 lines) split into focused modules:
  - `bin/config.js` (165 lines) — Config + endpoint detection
  - `bin/mcp_bridge.js` (151 lines) — Code graph MCP
  - `bin/executor.js` (338 lines) — Tool execution
  - `bin/model_client.js` (284 lines) — LLM communication
  - `bin/tools.js` (64 lines) — Tool definitions + routing
  - `bin/smallcode.js` now 1570 lines (28% reduction)
- Dependencies pinned to exact versions.
- `.env` excluded from npm package.
- README updated with accurate requirements and architecture.

## [0.4.19] - 2026-05-18

### Added
- **MCP Client** — SmallCode can now consume external MCP servers as tool providers. Configure in `.smallcode/mcp.json` or `~/.config/smallcode/mcp.json`. Tools from connected servers are auto-registered and available to the model.
  - MarrowScript source: `src/tools/mcp_client.ms`
  - JS runtime: `src/tools/mcp_client.js`
- **`/mcp` command** — Shows connected MCP servers and their available tools.
- MCP tools appear in the model's tool list as `mcp__serverName__toolName`.

## [0.4.18] - 2026-05-18

### Added
- **Programmatic API** — `const { SmallCode } = require('smallcode')` now works. Run prompts, subscribe to events (tool_start, tool_end, error, early_stop), get structured results with file changes, tool call records, and token usage.
  - MarrowScript source: `src/api/index.ms`
  - JS runtime: `src/api/index.js`
- **`main` field in package.json** — `require('smallcode')` now exports the API instead of nothing.
- **`/profile` command** added to Commands table in README.

## [0.4.17] - 2026-05-18

### Added
- **`/profile` command** — Shows detected model profile (context length, tool format, strengths/weaknesses, routing mode)
- **Repetition loop detection in streaming** — `streamFinalResponse` now uses early-stop detector to halt generation when model repeats itself
- **Governor MarrowScript updated** — `governor.marrow` now declares early-stop signals and tool routing tiers

### Fixed
- **Auth headers missing in `streamFinalResponse` and `sendToModel`** — Both streaming functions now send `Authorization` + OpenRouter headers. Previously these would 401 on cloud/authenticated endpoints.

## [0.4.16] - 2026-05-18

### Added
- **`-P` / `--prompt` flag** — Run a single prompt non-interactively: `smallcode -P "fix the bug"`
- **2-Stage Tool Router wired into agent loop** — Models with ≤16k context now get a `select_category` hint tool that reduces schema overhead. Override with `SMALLCODE_TOOL_ROUTING=direct` or `SMALLCODE_TOOL_ROUTING=two_stage`.
- **Model Profiles wired into boot** — Auto-detects model family (Gemma, Qwen, DeepSeek, etc.) from name and applies appropriate context window defaults.

## [0.4.15] - 2026-05-18

### Added
- **Early-Stop Detection Engine** — Detects and recovers from degenerate model behavior:
  - Repetition loop detection (same token sequence 3+ times → stops generation)
  - Patch spiral recovery (4+ consecutive patch failures → forces write_file rewrite)
  - Greeting regression detection (model outputs greeting mid-task → re-injects context)
  - MarrowScript source: `src/governor/early_stop.ms`
  - JS runtime: `src/governor/early_stop.js`

- **2-Stage Tool Router** (module ready, not yet wired into main loop)
  - Category selector reduces schema context by ~50% for small-context models
  - Auto-detects routing mode based on model context window (≤16k = 2-stage, >16k = direct)
  - JS runtime: `src/tools/two_stage_router.js`

- **Model Profiles** (module ready, not yet wired into main loop)
  - Per-model capability detection via fuzzy name matching
  - Profiles for Gemma 4, Qwen 3/2.5, DeepSeek, CodeLlama, Mistral Nemo, StarCoder
  - Drives routing mode, tool format, and context budget decisions
  - JS runtime: `src/model/profiles.js`

### Fixed
- **"Exit code undefined" display bug** — When `execSync` throws without a status code (e.g. EPERM, ENOENT), the error message now correctly shows "Timed out" instead of "Exit code undefined".

## [0.4.13] - 2026-05-18

### Fixed
- **Install no longer requires C++ build tools** — `budget-aware-mcp` (which needs `better-sqlite3` native compilation) moved to `optionalDependencies`. Install succeeds even without Python/gcc/make. SmallCode gracefully falls back to JSON-based memory when SQLite isn't available.
- **Playwright also made optional** — Web browsing (disabled by default anyway) won't block install on systems without Chromium deps.
- **Top-level require crash** — The `require('budget-aware-mcp')` was outside try/catch, crashing on startup if the module failed to install. Now wrapped with graceful fallback.

### Changed
- Updated README with accurate optional requirements for code graph features.

## [0.4.12] - 2026-05-18

### Fixed
- **Startup health check fails on authenticated endpoints** — `checkOllama` now sends `Authorization: Bearer` header when probing `/models`. Previously, remote servers requiring auth (oMLX, OpenRouter, etc.) would fail the startup check even with a valid API key configured.
- **Better error messages** — Startup no longer assumes "LM Studio" for all OpenAI-compatible endpoints. Shows specific hint on 401/403 to set `OPENAI_API_KEY`.

## [0.4.11] - 2026-05-18

### Fixed
- **Critical: API key not sent in requests** — `chatCompletion` now includes `Authorization: Bearer <key>` header when `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `DEEPSEEK_API_KEY` is set. Previously only local (no-auth) endpoints worked for the main agent loop.
- **OpenRouter support** — Added required `HTTP-Referer` and `X-Title` headers when `SMALLCODE_BASE_URL` points to `openrouter.ai`.
- **`/escalation` command crash** — `escalationEngine` was not in scope inside the command handler. Now passed as parameter to `createCommandHandler`.
- **`-v` flag collision** — `-v` was assigned to both `--version` and `--verbose`. Now `-v` is version, `-V` is verbose.
- **VERSION constant mismatch** — Was hardcoded as `0.1.0`, now reads `0.4.10` matching package.json.
- **Auto-compact destroying system messages** — Context compaction now preserves `role: 'system'` messages (skills, plugins) and only evicts user/assistant/tool messages.
- **ACP adapter version string** — Was stuck at `0.2.7`, now matches package version.

### Changed
- Removed dead `handleCommand` function from `bin/smallcode.js` (~110 lines of unreachable code).
- Pinned all dependency versions (removed caret ranges) per project conventions.
- Updated `.env.example` with OpenRouter configuration example.

## [0.2.0] - 2026-05-17

### Added
- **BoneScript Integration (Phase 1 + Phase 2 partial)**
  - `bone_compile` tool: Compile `.bone` files into complete Node.js/TypeScript backends
  - `bone_check` tool: Validate `.bone` files without generating code
  - `.bone` file validation in the improvement loop (auto-fix feedback)
  - Task classifier detects backend/API tasks and triggers BoneScript mode
  - System prompt dynamically injects BoneScript syntax guide when `taskType === 'backend'`
  - `bonescript-compiler` added as dependency (`file:../BoneScript/compiler`)
  - BoneScript quick reference module (`bin/bonescript_guide.js`)
  - Marrowscript source files for bone tools (`src/tools/builtin/bone_compile.ms`, `src/tools/builtin/bone_check.ms`)
  - Governor Marrowscript declaration updated with `backend` task type
  - Verifier updated to validate `.bone` files via `bone_check`

- **Model Escalation Engine**
  - When local model hard fails after decompose, escalate to a stronger model (Claude/OpenAI/DeepSeek)
  - Opt-in: requires API key via env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`) or `[escalation]` config
  - Supports Anthropic Messages API and OpenAI-compatible endpoints
  - Session-limited (default 5 escalations per session)
  - `/escalation` TUI command to view status
  - Marrowscript source: `src/governor/escalation.ms`
  - JS runtime: `bin/escalation.js`

- **Full-Screen TUI Engine**
  - Alternate screen buffer (terminal takeover, like OpenCode/vim)
  - Zero-dependency: raw ANSI escape sequences, no Ink/React/Bun needed
  - Panel layout: chat (scrollable) + optional tool panel (split view) + input + status bar
  - Raw mode input handling: arrow keys, history, PgUp/PgDn scroll, Ctrl+C exit
  - Dark/Light/Minimal themes with 24-bit RGB color support
  - Box drawing characters for borders and dividers
  - Streaming token display for real-time model output
  - Now the **default TUI** — use `--classic` flag for old readline mode
  - Marrowscript declaration: `src/tui/screen.ms`
  - JS runtime: `src/tui/fullscreen.js`

- **Plugin System**
  - Extend SmallCode with custom tools, commands, prompt injections, and hooks
  - Plugin locations: `.smallcode/plugins/` (project) and `~/.config/smallcode/plugins/` (global)
  - Each plugin is a directory with `plugin.json` manifest + JS handler files
  - Plugin tools are auto-injected into the model's tool list
  - Plugin prompts are injected into the system message based on task type
  - `/plugin list` command to show installed plugins
  - Runtime: `src/plugins/loader.js`

- **Skill System**
  - Reusable prompt templates that teach the model specific behaviors
  - Markdown files with YAML frontmatter (name, trigger, keywords)
  - Three trigger modes: `manual` (via /skill use), `auto` (always injected), `match` (keyword-activated)
  - Skills auto-activate when message matches keywords
  - `/skill list` — show all skills
  - `/skill add <name>` — create a new skill
  - `/skill use <name>` — activate for current conversation
  - `/skill remove <name>` — delete a skill
  - Skill locations: `.smallcode/skills/` (project) and `~/.config/smallcode/skills/` (global)
  - Runtime: `src/plugins/skills.js`

### Changed
- `bin/governor.js` — `classifyTask()` now detects backend/API creation tasks, scoped to Node.js/TypeScript only (respects Python/Go/Rust/etc)
- `bin/smallcode.js` — System prompt conditionally includes BoneScript guide; improvement loop now tracks decompose attempts and escalates on 2nd failure
- `bin/commands.js` — Added `/escalation` command
- `smallcode.toml` — Added `[escalation]` config section
- `src/tools/registry.ms` — Registered `bone_compile` and `bone_check` tools
- `src/governor/verifier.ms` — Added `.bone` extension to compile validation pipeline
- `src/governor/governor.marrow` — Added "backend" to task type constraint enum

## [0.1.0] - Initial Release

- Core agent loop with tool calling
- Improvement loop with auto-validation
- Governor with tool scoring and hard fail
- Compound tools for reduced tool call chains
- Memory integration (budget-aware-mcp SQLite+FTS5)
- Code graph MCP integration
- TUI with slash commands
- Model profiles for small LLMs
