# SmallCode

[简体中文](README_zh-CN.md) | [English](README.md)

---

[![npm](https://img.shields.io/npm/v/smallcode)](https://www.npmjs.com/package/smallcode)

**AI coding agent optimized for small LLMs (8B-35B parameters)**

SmallCode is a terminal-native coding agent designed from the ground up to extract useful work from local models (8B-35B) running on consumer hardware. While tools like OpenCode assume frontier models with 128k+ context and perfect tool calling, SmallCode compensates for the limitations of small models through intelligent architecture.

> **Recommended model size: 8B-35B parameters.** Smaller models (≤4B) struggle with multi-step tool use and lose context across turns. Larger models (>35B) don't need SmallCode's adaptations and are better served by tools designed for frontier models.

## Why SmallCode?

| | OpenCode | SmallCode |
|---|----------|-----------|
| **Target** | Frontier models (Claude, GPT-5) | 8B-35B local models |
| **Context** | Dumps everything | Budget-managed, summarized |
| **Tool calling** | Assumes reliable JSON | Forgiving multi-format parser |
| **Planning** | Single-shot | TODO-file decomposed steps |
| **Editing** | Full file write | Search-and-replace patch |
| **Privacy** | API calls to cloud | Fully local, no network needed |

## Quick Start

```bash
# Install globally via npm
npm install -g smallcode

# Or run directly with npx
npx smallcode

# Start in your project directory
cd my-project
smallcode
```

### Prebuilt Binaries (no Node.js needed)

Pre-compiled tarballs for Windows, macOS, and Linux are built on every release — they bundle Node.js plus all native addons so you never need `node-gyp` or C++ build tools.

| Platform | One‑line install |
|---|---|
| Linux / macOS | `bash <(curl -fsSL https://raw.githubusercontent.com/Doorman11991/smallcode/master/install.sh)` |
| Windows | `iwr -Uri https://raw.githubusercontent.com/Doorman11991/smallcode/master/install.ps1 -UseBasicParsing \| iex` |

The install script downloads the correct tarball for your platform, extracts it to `~/.smallcode`, and adds it to your PATH. Run `smallcode --help` to verify.

SmallCode includes [BoneScript](https://github.com/Doorman11991/BoneScript) and [budget-aware-mcp](https://github.com/Doorman11991/budget-aware-mcp) as dependencies — everything installs in one go.

### Fresh GitHub checkout quick start

If you just cloned/pulled this repository, run it directly from the checkout first:

```bash
cd smallcode
npm install

# Start your local model server first (LM Studio, llama.cpp, Ollama, etc.)
cat > .env <<'EOF'
SMALLCODE_MODEL=your-local-model-name
SMALLCODE_BASE_URL=http://localhost:1234/v1
EOF

node bin/smallcode.js
```

Optional: make the `smallcode` and `smallcode-rag-index` commands available globally from this checkout:

```bash
npm link
smallcode --help
```

If the fullscreen UI has display issues in your terminal, start with `node bin/smallcode.js --classic`.

### RAG harness quick run

SmallCode runs as a terminal UI harness by default:

```bash
smallcode                 # fullscreen TUI
smallcode --classic       # readline UI fallback
node bin/smallcode.js     # from a repo checkout
```

To build the local GitHub RAG database, run the Python scraper/indexer with the curated starter corpus, or use the broader preset for a larger multi-language corpus:

```bash
npm run rag:index
npm run rag:index -- --preset broad
# or, after install:
smallcode-rag-index --preset broad
```

For custom repos, create `.smallcode/rag/repos.json` with `preset`, `repos`, and chunking limits.

See [docs/rag-harness.md](docs/rag-harness.md) for the full LM Studio/llama.cpp setup, UI walkthrough, RAG config, indexing, and web-fallback flow.

### Requirements

- Node.js 18+ (LTS recommended — 20.x or 22.x have prebuilt binaries for SQLite)
- Python 3 + Git for the RAG scraper/indexer (`npm run rag:index`)
- A local LLM server (LM Studio, Ollama, or any OpenAI-compatible endpoint)

**Optional** (for code graph + FTS5 memory search):
- `better-sqlite3` needs native compilation if prebuilt binaries aren't available for your Node version
- Prebuilt binaries exist for Node LTS (20.x, 22.x) on Linux/macOS/Windows. no build tools needed
- If you're on a non-LTS Node (23+, 25+), you'll need:
  - **Linux**: `python3`, `make`, `gcc`/`g++` (`sudo apt install build-essential python3` or `pacman -S base-devel python`)
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: Visual Studio Build Tools with "Desktop development with C++" workload, or `npm install -g windows-build-tools`
- **If build fails, SmallCode still works** — it falls back to JSON-based memory automatically

### Configuration

Create a `.env` file in your project root:

```bash
# Required
SMALLCODE_MODEL=your-model-name
SMALLCODE_BASE_URL=http://localhost:1234/v1

# Optional: escalation (auto-fallback to cloud on hard fail)
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# OPENROUTER_API_KEY=sk-or-v1-...
# DEEPSEEK_API_KEY=sk-...
```

See `.env.example` for all options. Also supports `smallcode.toml` for backwards compatibility.

SmallCode can route each model tier to a different endpoint. This lets you keep
fast/default work local while sending complex tasks to a larger OpenRouter model:

```bash
SMALLCODE_MODEL=qwen3:8b
SMALLCODE_BASE_URL=http://localhost:11434/v1

SMALLCODE_MODEL_STRONG=openai/gpt-4o-mini
SMALLCODE_BASE_URL_STRONG=https://openrouter.ai/api/v1
OPENROUTER_API_KEY=sk-or-v1-...
```

Equivalent `smallcode.toml`:

```toml
[model]
provider = "openai"
name = "qwen3:8b"
baseUrl = "http://localhost:11434/v1"

[models.strong]
name = "openai/gpt-4o-mini"
baseUrl = "https://openrouter.ai/api/v1"
```

Tier URLs are optional. If `SMALLCODE_BASE_URL_STRONG` or
`[models.strong].baseUrl` is omitted, that tier uses the primary base URL.

## Architecture

SmallCode is built with a modular architecture:

```
bin/
├── smallcode.js        Entry point, agent loop, TUI orchestration (1570 lines)
├── config.js           Config loading, endpoint detection, auth headers
├── executor.js         Tool execution (all 18 tools)
├── tools.js            Tool definitions + 2-stage routing
├── mcp_bridge.js       Built-in code graph MCP communication
├── model_client.js     LLM API calls, streaming, validation
├── governor.js         Tool scoring, verification, decompose
├── escalation.js       Cloud model fallback (Claude/OpenAI/DeepSeek)
├── commands.js         TUI slash commands
├── tui.js              Classic TUI renderer
└── bonescript_guide.js BoneScript syntax reference

src/
├── api/index.js        Programmatic API (require('smallcode'))
├── tui/fullscreen.js   Fullscreen alternate-buffer TUI
├── plugins/loader.js   Plugin system
├── plugins/skills.js   Skill system
├── tools/              Tool routing, MCP client, validators
├── governor/           Early-stop detection, verifier, tool scorer
├── model/              Multi-model profiles + routing
└── session/            Persistence, undo, sharing, references
```

## Key Features

### MarrowScript Cognition Layer
SmallCode's intelligence is declared in [MarrowScript](https://github.com/Doorman11991/MarrowScript) and compiled to a production runtime. One 50-line `.marrow` declaration generates 1400+ lines of TypeScript with caching, retry, validation, traces, and budget enforcement — all for free.

```marrow
prompt classify_task_type(user_message: string) {
  model: TinyClassifier
  timeout: 3s
  cache: { key: hash(user_message), ttl: 10m }
  retry: { max_attempts: 2, backoff: fixed, interval: 100ms }
  constraints: [output in ["coding", "editing", "search", ...]]
}
```

The compiled cognition layer provides:
- **Prompt caching** — 0ms on cache hit, content-hash keys with TTL
- **Structured traces** — trace_id/span_id for every LLM call (enable with `SMALLCODE_COGNITION_LOG=stderr`)
- **Tier-based routing** — trivial tasks → tiny model, complex tasks → medium model
- **Token budgets** — per-cost-class enforcement, never overspend
- **Validation + repair** — schema checks with auto-retry on malformed output

### BoneScript Integration
For Node.js/TypeScript backends, SmallCode uses BoneScript — write ONE `.bone` file and compile it to a complete project (routes, auth, DB, events, migrations, SDK, admin panel, Docker, CI). Reduces 8-15 tool calls to 1-2, dramatically improving reliability with small models.

### Model Escalation
When the local model hard fails after retry + decompose, SmallCode can optionally escalate to a stronger cloud model (Claude, OpenAI, DeepSeek). Fully opt-in — requires an API key. Session-limited to prevent runaway costs.

**Escalation targets** (cloud, used only on hard fail):
- Claude Sonnet 4.5 / 4.6, Haiku 4.5
- GPT-5.4 Mini / Nano
- DeepSeek V4 / V4 Pro / V4 Flash

### Context Budget Engine
Never exceeds your model's context window. Tool results capped at 4k chars, mid-turn eviction drops old results when context grows too large, and semantic compression summarizes history instead of dropping it.

### 2-Stage Tool Routing
Halves the schema context overhead. Model picks a category (read/write/search/run/plan) first, then gets only relevant tool schemas. Critical for models with 8-16k context.

### Early-Stop Detection
Detects repetition loops, patch spirals (stuck on corrupted file → forces rewrite), and greeting regression (model lost context → re-injects task). Saves tokens and time.

### Forgiving Tool Call Parser
Small models produce messy output. SmallCode parses tool calls from JSON, YAML, XML, Hermes format, or plain text. Auto-repairs common mistakes (wrong param names, type mismatches).

### Patch-First Editing
Search-and-replace as the primary edit primitive. Small models can't reliably reproduce entire files — they truncate, hallucinate, or drift. `patch` is safer and more context-efficient.

### TODO-Driven Planning
Complex tasks get decomposed into atomic steps. The model reads a TODO file each turn to know where it is. Each step is validated (lint/compile) before moving on.

### Model Profiles
Per-model configuration: context length, tool format (native/hermes/json/xml/text), chat template, strengths/weaknesses. Auto-adapts prompting strategy.

### Working Memory
Persistent scratchpad that survives across turns. Compensates for limited reasoning depth — the model can write notes to itself.

### Persistent Shell Sessions
`bash` calls share a long-lived shell process so `cd`, env vars, and shell variables persist across calls. Without this, every bash call is a fresh process, breaking multi-step tasks like "cd src then run pytest". Optional cwd-containment refuses any `cd` (or `pushd`/`chdir`/sub-shell escape) that would leave the project root. Disable with `SMALLCODE_SHELL_PERSIST=false`.

### Thinking Budget Control
Modern reasoning models (Qwen3, DeepSeek R1, GPT-5 reasoning) can spend thousands of tokens "thinking" about trivial tasks. SmallCode caps thinking budget per call (Anthropic `budget_tokens`, OpenAI `reasoning_effort`, Qwen `enable_thinking`, DeepSeek style — all set defensively) and hard-truncates oversize thinking blocks before they enter conversation history. Configure with `SMALLCODE_THINKING_BUDGET=2000` (default), or `SMALLCODE_THINKING_DISABLE=true` to turn off entirely.

### Knowledge Injection
Drop short reference notes into a `knowledge/` directory and the most relevant ones get injected into the system prompt based on keyword overlap with your message. Designed for small models that benefit from algorithm cheat sheets or syntax reminders inline. See `knowledge/README.md` for the format. Configurable budget (default 1500 tokens) via `SMALLCODE_KNOWLEDGE_MAX_TOKENS`.

### Bundled Skills
Six dev-methodology skills ship in `skills/` (brainstorming, debugging, tdd, iterative-retrieval, learn, external-guard). They load automatically alongside project skills in `.smallcode/skills/`. Use `/skill list` and `/skill use <name>`. See `skills/README.md`. Adapted from [Willow 2.0 Fylgja](https://github.com/rudi193-cmd/willow-2.0/tree/master/willow/fylgja/skills).

SmallCode also auto-detects skills in two nested layouts already used by other agents in the ecosystem:

- `.agents/skills/<name>/SKILL.md` — itsy / jukefr layout (closes #53)
- `.claude/skills/<name>/SKILL.md` — Claude Code layout (closes #53)

Skills loaded from these layouts are accepted without YAML frontmatter; the directory name becomes the skill name. Skill files with CRLF line endings now load correctly on Windows (closes #52).

### Plugin System
Plugins live under `.smallcode/plugins/<name>/` (project), `~/.smallcode/plugins/<name>/` (user), or `~/.config/smallcode/plugins/<name>/` (global). Each plugin has a `plugin.json` manifest declaring tools, commands, hooks, prompt injections, providers, permissions, and MCP servers. Five lifecycle hooks fire at the right points in the agent loop: `pre_request`, `post_request`, `on_error`, `session_start`, `session_end`. Plugin-contributed providers register with the `ProviderRegistry` and `resolveProvider()` looks them up by name before falling back to the OpenAI-compat adapter. An example Anthropic provider plugin ships in `.smallcode/plugins/anthropic-provider/`. Install with `/plugin install <pkg> [--scope project|user|global]`.

### `/provider` — Interactive Provider Wizard
Configure your LLM provider without hand-editing `.env`. The wizard walks through provider selection (LM Studio, Ollama, OpenRouter, OpenAI, Anthropic, DeepSeek, custom), base URL (with provider defaults), API key (probed against `/v1/models` to validate), model name, and an optional escalation fallback. Saves to `~/.config/smallcode/.env` (global), `./.env` (project), or both. Available as the `configure_provider` tool for the model and `/provider` (or `/provider status`) in the REPL.

### Quality Monitor (itsy port)
Catches four structural failure modes per turn — empty turns, blank tool names, hallucinated tool names (returns closest matches as suggestions), and exact-repeat tool calls across turns. On a hit it injects a `[QUALITY-MONITOR]` steer back into the conversation; capped at 2 consecutive corrections to prevent spirals. Disable with `SMALLCODE_QUALITY_MONITOR=false`.

### Context-Aware Read Guard (itsy port)
Replaces the dumb fixed-byte tool-result cap. When live context usage is past the budget OR the file alone exceeds 50% of the model's window, returns the first 30 lines of the file (imports + signatures) plus an explicit "use grep / read a smaller line range" directive instead of a silent middle-of-file truncation. Falls back to head/tail trim with a clearer redirect hint for read-shaped tools. Disable with `SMALLCODE_READ_GUARD=false`. Tune head size with `SMALLCODE_READ_GUARD_HEAD_LINES=30`.

### Read-Before-Write Guard
Tracks which paths the model has read this session. First `write_file` to an existing unread file is refused with a hint to `read_file` first; second attempt allowed (so legitimate full-replace intents succeed). New files always permitted. `patch` counts as a read. Disable with `SMALLCODE_WRITE_GUARD=false`.

### Tool-Call Deduplication
Identical pure-tool calls within a sliding window are short-circuited with a cached result instead of re-executing. Only applies to read-only tools (`read_file`, `search`, `graph_search`, etc.) — never to anything with side effects. Saves both context and latency on small models that loop. Disable with `SMALLCODE_DEDUP=false`.

A second, stricter guard handles **idempotent-write tools** (`memory_remember`, `memory_forget`): identical calls in the same turn are short-circuited with `[already stored this turn]` instead of re-executing. Resets between turns rather than between sessions. Closes the spam-loop gap where small models could call `memory_remember` 30+ times with the same args. Disable with `SMALLCODE_IDEMPOTENT_WRITE_DEDUP=false`.

### Evidence Store
Automated capture of "what was tried, what worked, what failed" per task. Stored as searchable memory objects in the existing memory MCP module so they flow through FTS5 + staleness-decay loading on future tasks rather than always hogging context. The model learns from past sessions: it sees that `pip install` failed last time on this Python version, or that `npm test` hangs without `--run`. Disable with `SMALLCODE_EVIDENCE_DISABLE=true`.

### Plan-Then-Execute Mode
For multi-step tasks (refactors, multi-file features, multi-imperative prompts), SmallCode asks the model to emit a numbered plan FIRST, then re-injects that plan as an anchor on subsequent turns. Reduces drift on long traces — the model can't "forget" step 3 by the time it finishes step 1. Heuristic-based — simple tasks like "create hello.py" don't trigger planning. Configure with `SMALLCODE_PLAN=true|false`.

### Contract / Definition of Done
For tasks where "done" should be hard-fail rather than self-reported, SmallCode supports per-project **contracts** — a declarative list of testable assertions the model commits to up-front. The agent cannot deliver a final "I'm done"-shaped response while any assertion remains `pending` or `failed`. The model uses `contract_create` to declare assertions, `contract_assert_pass` / `contract_assert_fail` / `contract_assert_skip` to record progress with command-line evidence, and `contract_status` to inspect remaining blockers. State persists to `.smallcode/contracts/<id>/` (state.json, contract.md, assertions.md, log.jsonl). Slash command `/contract` lists, activates, and aborts contracts. Inspired by [jukefr/itsy](https://github.com/jukefr/itsy)'s same-named feature. Disable the done-guard with `SMALLCODE_CONTRACT=false`.

### Snapshot & Auto-Rollback
Before each agent turn, SmallCode opens a file snapshot checkpoint. Every `write_file` and `patch` records its pre-edit content. If validation hard-fails and all retries are exhausted, set `SMALLCODE_SNAPSHOT_AUTO_ROLLBACK=true` to automatically revert all edits in the turn back to the checkpoint state. All snapshots persisted to `.smallcode/snapshots/` for manual audit. Disable with `SMALLCODE_SNAPSHOT=false`.

### Test-Runner Auto-Discovery
Detects your project's test command from config files (package.json, pytest.ini, pyproject.toml, Cargo.toml, go.mod, pom.xml, etc.) and injects it into the system prompt once. The model knows how to run tests without wasting tool calls on discovery. Also surfaces in AUTO-VALIDATE fix prompts. Override with `SMALLCODE_TEST_RUNNER=<cmd>` or disable with `SMALLCODE_TEST_DISABLE=true`.

### Bootstrap Detection
On first turn, scans the workspace and injects a compact project summary: runtime + version, package manager, framework (Next.js/FastAPI/Express/Django/React/Vue/…), entry point, and build/test/run commands. Covers Node, Python, Rust, Go, .NET, Java, Ruby. Eliminates the 3-5 tool calls small models usually spend figuring out what kind of project they're in. Disable with `SMALLCODE_BOOTSTRAP=false`.

### Adaptive Retry Temperature
When the improvement loop retries a failed edit, each attempt uses a different temperature so it doesn't produce the same broken output three times. Attempt 1 lowers temperature (deterministic fix), attempt 2 raises it (explore alternatives), attempt 3 returns to base. Delta defaults to 0.15. Disable with `SMALLCODE_TEMP_ADAPT=false`.

### Per-Tool Trust Score Decay
Tracks consecutive failures per tool within a session. Tools that fail 3+ times in a row are soft-demoted (schema list back). Tools that fail 5+ times are dropped from the schema entirely for the session. Prevents the model from looping on a broken MCP server or a search that keeps returning nothing. Resets between runs. Disable with `SMALLCODE_TRUST_DECAY=false`.

### Code Intel Category (Rank 2)
A new `code_intel` tool routing category detects semantic code questions ("how does X work", "what calls Y", "who inherits from Z"). Routes exclusively to `[graph_search, explain_symbol, read_file, find_files, search]` — skipping write/run tools. Placed before `search` in the priority order so inheritance/callers questions get the right tools without any write noise.

### Error Diagnosis (Rank 4)
When a bash command exits non-zero, `diagnoseError()` makes a quick LLM call to classify the error type (`syntax|runtime|permission|notfound|timeout|unknown`), locate the relevant file/line, and emit a one-line fix suggestion. The structured hint is prepended as `[ERROR-DIAGNOSIS]` to the tool result so the model has typed, located context to act on immediately. Cached 5 min. TTL configurable.

### Decompose Task (Rank 5)
`decomposeTask()` replaces the hand-rolled `pickDecomposeStrategy()` regex when a file keeps failing after all retries. The LLM selects a strategy (`split_file|one_error_at_a_time|rewrite_section|extract_function`) with a reason and concrete 2-3 sentence instruction. Falls back to the regex governor. Cached 5 min.

### Multi-File Edit Coordination (Rank 6)
When 3 or more files are edited in a single agent turn, `coordinateMultiFileEdit()` injects a `[MULTI-FILE-EDIT]` header listing all files that need changes. Keeps small models from forgetting file 3 while editing file 2. De-duplicates: only injects once per turn even if called repeatedly.

### Semantic Merge (Rank 7)
When `patch` fails because `old_str` no longer exists in the file, `semanticMerge()` asks the model to merge the intended change into the current file content. Returns the complete corrected file. Replaces the hard error with a recovery attempt. TTL 1 min (content-specific).

### Adaptive Model Select (Rank 8)
`AdaptiveModelRouter` in `src/model/adaptive_router.js` tracks per-model call/fail counts. When the primary model's failure rate exceeds 0.3 (medium) or 0.6 (strong), `chatCompletion` automatically routes to `SMALLCODE_MODEL_MEDIUM` or `SMALLCODE_MODEL_STRONG` and their matching `SMALLCODE_BASE_URL_*` endpoint when configured. Requires at least 3 calls before routing decisions activate. Reset via `router.reset()`.

```bash
# Optional: configure fallback models for adaptive routing
SMALLCODE_MODEL_MEDIUM=qwen2.5-coder:32b
SMALLCODE_MODEL_STRONG=gpt-4o
SMALLCODE_BASE_URL_STRONG=https://openrouter.ai/api/v1
```

### Benchmark Harness
Run the included benchmark suite against any local model to measure pass rate across small coding tasks. Three suites: `smoke` (5 trivial tasks, ~30s), `polyglot-mini` (19 tasks across Python/JS/TS/Bash/Markdown/JSON), `tool-use` (10 multi-step tool sequencing tasks). Results persisted to `.smallcode/benchmarks/`.

```bash
npm run bench:smoke
npm run bench:polyglot
npm run bench:tools
```

### Benchmark Diff Tool
Compare two harness runs (or a stored baseline against a fresh run) and get an exit-coded verdict you can use in CI: `0` improved, `1` regressed, `2` noise.

```bash
npm run bench:diff bench/baselines/main bench/baselines/feature
# or with a custom threshold:
node bench/diff.js bench/baselines/main bench/baselines/feature --threshold 0.05 --json
```

Reports mean reward delta, per-task pass-count moves (no task should regress), wall-clock delta, and tool-call delta. Pairs with the `benchmark-driven-development` skill at `skills/benchmark-driven-development.md` — the discipline of measure-first / change-second / measure-again before any agent-behaviour change ships. Adapted from [jukefr/itsy](https://github.com/jukefr/itsy).


## Commands

| Command | Description |
|---------|-------------|
| `/quit`, `/q` | Exit SmallCode |
| `/clear` | Reset conversation |
| `/stats` | Show session statistics |
| `/tokens` | Detailed token usage report |
| `/budget` | Context window budget + visual bar |
| `/trace` | List/show/export execution traces |
| `/eval` | Run prompt evaluation suites |
| `/memory` | Show working memory |
| `/contract` | Definition-of-Done contract: list / activate / abort |
| `/plan` | Show current task plan |
| `/model` | Show/switch model |
| `/profile` | Show detected model profile + routing mode |
| `/cognition` | Show MarrowScript cognition layer status |
| `/mcp` | Show connected external MCP servers |
| `/skill` | Manage reusable skills |
| `/plugin` | Install/manage plugins (`--scope project|user|global`) |
| `/provider` | Configure LLM provider (interactive wizard) |
| `/sessions` | List/resume saved sessions |
| `/version`, `/v` | Show SmallCode version + Node/platform |
| `/help` | Show all commands |

## Observability

SmallCode tracks token usage and execution traces automatically:

- **Token Monitor** — Every LLM call records prompt/completion tokens. View with `/tokens`.
- **Context Budget** — Visual indicator of context window usage. View with `/budget`.
- **Execution Traces** — Every agent turn is recorded to `.smallcode/traces/`. View with `/trace list`.
- **Trace-to-Test** — Generate regression tests from traces: `/trace test <id>`.
- **Prompt Evaluations** — Measure classifier accuracy and tool selection: `/eval classify_accuracy`.

```bash
# Run evaluations from CLI
smallcode --eval classify_accuracy
smallcode --eval tool_selection
```

## Programmatic API

Use SmallCode as a library in your own tools, CI pipelines, or TypeScript frameworks:

```javascript
const { SmallCode } = require('smallcode');

const agent = new SmallCode({
  model: 'gemma-4-e4b',
  baseUrl: 'http://localhost:1234/v1',
});

// Run a task
const result = await agent.run("create hello.py that prints hello world");
console.log(result.filesCreated);  // ['hello.py']
console.log(result.toolCalls.length);  // 1
console.log(result.success);  // true

// Subscribe to events
agent.on('tool_start', ({ name, args }) => console.log(`Using: ${name}`));
agent.on('tool_end', ({ name, ms }) => console.log(`Done: ${name} (${ms}ms)`));
agent.on('error', (err) => console.error(err));
```

Returns a structured `RunResult` with: response text, tool call records, files created/edited, token usage, duration, and success status.

## Tools

| Tool | Description |
|------|-------------|
| `bone_compile` | Compile .bone to full backend project |
| `bone_check` | Validate .bone file (type errors, constraints) |
| `list_projects` | List all indexed projects with stats |
| `graph_search` | Code graph symbol search |
| `explain_symbol` | Full symbol explanation (callers, callees) |
| `read_file` | Read file contents |
| `write_file` | Create/overwrite files |
| `patch` | Search-and-replace edit |
| `bash` | Run shell commands |
| `search` | Regex search (ripgrep) |
| `find_files` | Glob file search |
| `memory_load` | Load relevant project memory |
| `memory_remember` | Save knowledge to memory |
| `web_search` | Search the web via DuckDuckGo (requires `SMALLCODE_WEB_BROWSE=true`) |
| `web_fetch` | Fetch and extract text from a URL (requires `SMALLCODE_WEB_BROWSE=true`) |
| `contract_create` | Declare a Definition-of-Done with a list of testable assertions |
| `contract_status` | Show the active contract: assertions, state, blockers |
| `contract_assert_pass` | Mark an assertion passed (with command-line evidence) |
| `contract_assert_fail` | Mark an assertion failed (with evidence) |
| `contract_assert_skip` | Mark an assertion skipped (out of scope) |

### Web Browsing

SmallCode includes Playwright with stealth mode for undetected web browsing. Disabled by default — enable for medium/large models (20B+) that can synthesize web context effectively:

```bash
# In your .env
SMALLCODE_WEB_BROWSE=true
```

The browser packages are **opt-in peer dependencies** so a default install is light and skips a few deprecated transitives. Install them once when you actually want web browsing:

```bash
npm install -g playwright-extra puppeteer-extra-plugin-stealth
npx playwright install chromium
```

When enabled, the model can search the web and fetch documentation during tasks. Uses headless Chromium with anti-detection to avoid CAPTCHAs and bot blocks. Falls back to simple HTTP fetch if Playwright isn't available.

## License

MIT
