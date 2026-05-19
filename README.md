# SmallCode

[简体中文](README_zh-CN.md) | [English](README.md)

---

[![npm](https://img.shields.io/npm/v/smallcode)](https://www.npmjs.com/package/smallcode)

**AI coding agent optimized for small LLMs (≤20B parameters)**

SmallCode is a terminal-native coding agent designed from the ground up to extract useful work from local models (7B-20B) running on consumer hardware. While tools like OpenCode assume frontier models with 128k+ context and perfect tool calling, SmallCode compensates for the limitations of small models through intelligent architecture.

## Why SmallCode?

| | OpenCode | SmallCode |
|---|----------|-----------|
| **Target** | Frontier models (Claude, GPT-4) | 7B-20B local models |
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
| Linux / macOS | `bash <(curl -fsSL https://raw.githubusercontent.com/Doorman11991/smallcode/main/install.sh)` |
| Windows | `iwr -Uri https://raw.githubusercontent.com/Doorman11991/smallcode/main/install.ps1 -UseBasicParsing \| iex` |

The install script downloads the correct tarball for your platform, extracts it to `~/.smallcode`, and adds it to your PATH. Run `smallcode --help` to verify.

SmallCode includes [BoneScript](https://github.com/Doorman11991/BoneScript) and [budget-aware-mcp](https://github.com/Doorman11991/budget-aware-mcp) as dependencies — everything installs in one go.

### Requirements

- Node.js 18+ (LTS recommended — 20.x or 22.x have prebuilt binaries for SQLite)
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
# DEEPSEEK_API_KEY=sk-...
```

See `.env.example` for all options. Also supports `smallcode.toml` for backwards compatibility.

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


## Commands

| Command | Description |
|---------|-------------|
| `/quit`, `/q` | Exit SmallCode |
| `/clear` | Reset conversation |
| `/stats` | Show session statistics |
| `/memory` | Show working memory |
| `/plan` | Show current task plan |
| `/model` | Show/switch model |
| `/profile` | Show detected model profile + routing mode |
| `/cognition` | Show MarrowScript cognition layer status |
| `/mcp` | Show connected external MCP servers |
| `/skill` | Manage reusable skills |
| `/plugin` | Install/manage plugins |
| `/sessions` | List/resume saved sessions |
| `/help` | Show all commands |

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

### Web Browsing

SmallCode includes Playwright with stealth mode for undetected web browsing. Disabled by default — enable for medium/large models (20B+) that can synthesize web context effectively:

```bash
# In your .env
SMALLCODE_WEB_BROWSE=true
```

When enabled, the model can search the web and fetch documentation during tasks. Uses headless Chromium with anti-detection to avoid CAPTCHAs and bot blocks. Falls back to simple HTTP fetch if Playwright isn't available.

## License

MIT
