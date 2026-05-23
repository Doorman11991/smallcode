#!/usr/bin/env node
// SmallCode — AI coding agent for small LLMs
// Entry point: parses args, boots the TUI or runs in non-interactive mode
//
// This is the bootstrap that loads until the Marrowscript runtime is ready.
// It provides the same interface the compiled .marrow output would.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env file (checks multiple locations, first found wins)
(function loadDotenv() {
  const os = require('os');
  const envPaths = [
    path.join(process.cwd(), '.env'),                          // project root
    path.join(process.cwd(), '.smallcode', '.env'),            // .smallcode dir
    path.join(os.homedir(), '.config', 'smallcode', '.env'),   // global config
    path.join(os.homedir(), '.smallcode', '.env'),             // global alt
  ];

  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Remove surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Don't override existing env vars
        if (!process.env[key]) process.env[key] = value;
      }
      break; // Use first found .env file
    } catch {}
  }
})();
const readline = require('readline');
const os = require('os');
const tui = require('./tui');
const chalk = tui.chalk;
const { loadConfig: loadConfigModule, checkEndpoint } = require('./config');
const { TOOLS, COMPOUND_TOOLS, getAllTools: _getAllToolsModule } = require('./tools');
const { runValidation: _runValidationModule } = require('./model_client');
const { mcpCall, initCodeGraph, killMCP, getMcpProcess } = require('./mcp_bridge');
const { executeTool: _executeToolModule } = require('./executor');
let McpMemoryStore;
try {
  McpMemoryStore = require('budget-aware-mcp/dist/memory/store.js').MemoryStore;
} catch {
  McpMemoryStore = null;
}
const { ToolScorer, checkAndEnforceHardFail, classifyTask, classifyTaskAsync } = require('./governor');
const { EscalationEngine } = require('./escalation');
const { EarlyStopDetector } = require('../src/governor/early_stop');
const { TokenMonitor } = require('./token_monitor');
const { TraceRecorder } = require('./trace_recorder');
const { EvalRunner } = require('./eval_runner');
const {
  repairToolCall,
  summarizeFileCompiled,
  assertWithinBudget,
  chargeBudget,
  getBudgetState,
  setApprovalHandler,
  awaitCheckpointDecision,
  submitCheckpointDecision,
  retrieveContext,
  validateEditCompiled,
} = (() => { try { return require('./features_adapter'); } catch { return {}; } })();
const { getProfile } = require('../src/model/profiles');
const { MCPClient } = require('../src/tools/mcp_client');
const { PluginLoader } = require('../src/plugins/loader');
const { SkillManager } = require('../src/plugins/skills');
const { SessionStore } = require('../src/session/persistence');
const { resolveReferences, formatReferencesForPrompt } = require('../src/session/references');
const { TokenTracker } = require('../src/session/tokens');
const { UndoStack } = require('../src/session/undo');
const { shouldInjectGitContext, getGitDiffContext } = require('../src/session/git_context');
const { routeModel } = require('../src/model/router');

// Initialize structured memory (budget-aware-mcp's SQLite + FTS5 store, falls back to JSON)
let memoryStore;
try {
  if (McpMemoryStore) {
    memoryStore = new McpMemoryStore(process.cwd());
  } else {
    throw new Error('budget-aware-mcp not available');
  }
} catch {
  const { MemoryStore } = require('./memory');
  memoryStore = new MemoryStore(process.cwd());
}

// Initialize governor (tool scoring + verification)
const toolScorer = new ToolScorer();
const earlyStop = new EarlyStopDetector();
const tokenMonitor = new TokenMonitor();
const traceRecorder = new TraceRecorder(process.cwd());
let currentToolCategory = null; // Set per-turn by compiled tool router
let currentTaskType = 'coding';
let config = null; // Set in main(), used by executeTool and chatCompletion

// Initialize escalation engine (lazy — resolves config at boot)
let escalationEngine = null; // created after config loads

// Initialize plugin + skill systems
let pluginLoader = null;
let skillManager = null;

// Session persistence + token tracking
let sessionStore = null;
let tokenTracker = null;

// Fullscreen TUI reference for streaming (set when fullscreen mode is active)
let _fullscreenRef = null;

const VERSION = require('../package.json').version;
const LOGO = `
  ⚡ SmallCode v${VERSION}
  AI coding agent for small LLMs
`;

// ─── Built-in MCP: code graph (delegated to mcp_bridge.js) ──────────────────
// mcpCall, initCodeGraph, killMCP imported from ./mcp_bridge

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-h' || arg === '--help') flags.help = true;
  else if (arg === '--version') flags.version = true;
  else if (arg === '-V' || arg === '--verbose') flags.verbose = true;
  else if (arg === '-v') flags.version = true;
  else if (arg === '-r' || arg === '--resume') flags.resume = true;
  else if (arg === '--mcp') flags.mcp = true;
  else if (arg === '--acp') flags.acp = true;
  else if (arg === '--init' || arg === 'init') flags.init = true;
  else if (arg === '--non-interactive') flags.nonInteractive = true;
  else if (arg === '--classic') flags.classic = true;
  else if (arg === '-m' || arg === '--model') { flags.model = args[++i]; }
  else if (arg === '-p' || arg === '--provider') { flags.provider = args[++i]; }
  else if (arg === '--endpoint' || arg === '--base-url') { flags.endpoint = args[++i]; }
  else if (arg === '-P' || arg === '--prompt') { flags.prompt = args[++i]; }
  else if (arg === '--eval') { flags.eval = args[++i] || 'classify_accuracy'; }
  else if (arg === '--trace') { flags.trace = args[++i]; }
  else positional.push(arg);
}

// ─── Quick exits ─────────────────────────────────────────────────────────────

if (flags.version) {
  console.log(`smallcode v${VERSION}`);
  process.exit(0);
}

if (flags.help) {
  console.log(`${LOGO}
USAGE:
  smallcode [OPTIONS] [PROMPT]

OPTIONS:
  -h, --help              Show this help
  -v, --version           Show version
  -V, --verbose           Verbose output (show tool I/O)
  -m, --model <NAME>      Model to use (default: qwen2.5-coder:14b)
  -p, --provider <NAME>   Provider (ollama, openai, anthropic, llamacpp)
  --endpoint <URL>        OpenAI-compatible endpoint/base URL
  -P, --prompt <TEXT>     Run a single prompt non-interactively
  -r, --resume            Resume last active session
  --non-interactive       Run single prompt, no TUI
  --classic             Use classic readline TUI (no alternate screen)
  --mcp                   Run as MCP server (JSON-RPC over stdio)
  --eval <SUITE>          Run prompt evaluation suite
  --trace <ID>            Replay a recorded trace

COMMANDS (in TUI):
  /quit, /q       Exit
  /clear          Reset conversation
  /stats          Session statistics
  /memory         Show working memory
  /plan           Show task plan
  /undo           Revert last edit
  /sessions       List saved sessions
  /save           Save session
  /eval           Run prompt evaluation
  /budget         Show token budget
  /help           All commands

EXAMPLES:
  smallcode                                Start interactive TUI
  smallcode "fix the bug in main.ts"       Single prompt
  smallcode -m qwen3:8b                    Use specific model
  smallcode --resume                       Continue last session
  smallcode --mcp                          Start as MCP server
  echo "refactor" | smallcode --non-interactive
`);
  process.exit(0);
}

// ─── Config ──────────────────────────────────────────────────────────────────

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  return loadConfigModule(flags);
}

// ─── Endpoint Check (delegated to config module) ─────────────────────────────

async function checkOllama(config) {
  return checkEndpoint(config);
}

// ─── TUI ─────────────────────────────────────────────────────────────────────

// Conversation history for multi-turn
const conversationHistory = [];

// Plan tracker — Feature 8 plan-then-execute. Lazy-instantiated per agent run.
let _planTracker = null;
// Per-run detectors (Features 4, 10-11): re-built each runAgentLoop call
// bound to process.cwd() so bench tasks in temp dirs get correct context.
let _bootstrapDetector = null;
let _testRunnerDetector = null;
let _knowledgeLoader = null;
const improvementAttempts = {}; // filePath → attempt count

async function runTUI(config) {
  const createCommandHandler = require('./commands');
  const handleCmd = createCommandHandler(config, conversationHistory, improvementAttempts, runAgentLoop, runValidation, MAX_IMPROVE_ITERATIONS, memoryStore, escalationEngine, tokenMonitor);

  const ok = await checkOllama(config);
  if (!ok && config.model.provider === 'ollama') {
    process.exit(1);
  }

  // Start built-in code graph MCP
  let graphOk = false;
  process.stdout.write(chalk.gray('  Code graph: '));
  graphOk = await initCodeGraph();
  if (graphOk) {
    console.log(chalk.green('✓ indexed'));
  } else {
    console.log(chalk.gray('disabled'));
  }

  // ─── FULLSCREEN TUI (default) ─────────────────────────────────────────
  if (!flags.classic) {
    const { FullScreenTUI } = require('../src/tui/fullscreen.js');

    const screen = new FullScreenTUI({
      model: config.model.name,
      theme: config.tui?.theme || 'dark',
      showToolPanel: (process.stdout.columns || 80) > 120,
      onSubmit: async (input) => {
        screen.setStreaming(true);
        await runAgentLoop(input, config);
        screen.setStreaming(false);
        // Update token counter in status bar
        if (tokenTracker) screen.setTokenInfo(tokenTracker.formatShort());
      },
      onCommand: async (cmd) => {
        if (cmd === '/quit' || cmd === '/q' || cmd === '/exit') {
          if (sessionStore) sessionStore.save(conversationHistory, { tokens: tokenTracker ? tokenTracker.stats() : undefined });
          screen.leave();
          killMCP()
          process.exit(0);
        }
        // Capture command output by temporarily redirecting stdout + console.log
        const origWrite = process.stdout.write.bind(process.stdout);
        const origConsoleLog = console.log;
        let captured = '';
        process.stdout.write = (chunk) => { captured += chunk.toString(); return true; };
        console.log = (...args) => { captured += args.join(' ') + '\n'; };
        // Create a mock rl for command handler
        const mockRl = { prompt: () => {}, close: () => { screen.leave(); process.exit(0); } };
        try {
          await handleCmd(cmd, mockRl);
        } catch (e) {
          captured += `Error: ${e.message}\n`;
        }
        process.stdout.write = origWrite;
        console.log = origConsoleLog;
        if (captured.trim()) {
          // Strip ANSI codes for clean display in chat panel
          const clean = captured.replace(/\x1b\[[0-9;]*m/g, '').trim();
          screen.addChat('system', clean);
        }
        screen.render();
      },
      onExit: () => {
        // Save session before exit
        if (sessionStore) {
          sessionStore.save(conversationHistory, { tokens: tokenTracker ? tokenTracker.stats() : undefined });
        }
        killMCP()
        process.exit(0);
      },
    });

    // Enter fullscreen FIRST (captures real stdout.write as _rawWrite)
    screen.enter();
    _fullscreenRef = screen;

    // Track current tool name for pairing stdout.write (tool start) with console.log (result)
    let _currentToolName = '';

    // Override console.log to push tool output to the screen with detail
    const origLog = console.log;
    console.log = (...args) => {
      const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!clean) return;
      // Skip turn summaries unless verbose
      if (clean.startsWith('───') && !flags.verbose) return;
      // Pair with current tool name for rich display
      if (_currentToolName) {
        const isError = clean.startsWith('✗') || clean.includes('Exit code') || clean.includes('Timed out');
        screen.addTool(_currentToolName, isError ? 'err' : 'ok', clean);
        _currentToolName = '';
      } else {
        screen.addTool('', 'ok', clean);
      }
    };

    // Override process.stdout.write — capture tool name from tui.toolStart calls
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!text) return true;
      // tui.toolStart outputs "  ⚙ toolName " — extract the tool name
      const toolMatch = text.match(/^⚙\s*(\S+)/);
      if (toolMatch) {
        _currentToolName = toolMatch[1];
      }
      return true;
    };

    return; // Event loop takes over via raw stdin
  }

  // ─── CLASSIC TUI (--classic flag) ─────────────────────────────────────
  console.log(tui.renderWelcome(config, graphOk));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('› '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input.startsWith('/')) {
      await handleCmd(input, rl);
      return;
    }

    console.log('');
    await runAgentLoop(input, config);
    console.log('');
    console.log(tui.renderStatus(config, conversationHistory.length));
    rl.prompt();
  });

  rl.on('close', () => {
    killMCP()
    if (_lspClient) { try { _lspClient.stop(); } catch {} }
    console.log(chalk.gray('\n  Goodbye!\n'));
    process.exit(0);
  });
}

// ─── Model Communication ─────────────────────────────────────────────────────

// Tool definitions imported from bin/tools.js (TOOLS, COMPOUND_TOOLS, getAllTools)

// Show a compact inline diff for patch operations
function showMiniDiff(filePath, oldStr, newStr, lineNum) {
  const diff = tui.renderDiff(filePath, oldStr, newStr, lineNum);
  if (diff) console.log(diff);
}

// Execute a tool call — delegates to executor.js module.
// Wrapped with dedup (Feature 6): identical pure-tool calls within the recent
// window are short-circuited with a cached result. Disable with SMALLCODE_DEDUP=false.
async function executeTool(name, args) {
  let dedup = null;
  try {
    const { getDedup, ToolDedup } = require('../src/tools/dedup');
    dedup = getDedup();
    const cached = dedup.lookup(name, args);
    if (cached) return ToolDedup.markCached(cached);
  } catch {}

  // Per-turn idempotent-write dedup: stop spirals where the model calls
  // memory_remember (or memory_forget) with the same args repeatedly within
  // a single turn. PURE_TOOLS dedup doesn't cover these — they DO mutate state
  // and can't be cached across turns — but inside a turn they're idempotent
  // and re-calling is always wasted work.
  let writeSet = null;
  try {
    const { getIdempotentWriteSet } = require('../src/tools/dedup');
    writeSet = getIdempotentWriteSet();
    if (writeSet.has(name, args)) {
      return writeSet.shortCircuitResult(name);
    }
  } catch {}

  const result = await _executeToolModule(name, args, {
    _fullscreenRef,
    mcpCall,
    memoryStore,
    pluginLoader,
    mcpClient: (typeof mcpClient !== 'undefined' ? mcpClient : null),
    flags,
    config,
    tui,
  });

  try { if (dedup) dedup.record(name, args, result); } catch {}
  try { if (writeSet) writeSet.record(name, args, result); } catch {}
  return result;
}

// ─── COMPOUND TOOLS ──────────────────────────────────────────────────────────
// Tool definitions + routing loaded from bin/tools.js
// getAllTools delegates to the module with plugin/mcp context.
// Trust decay (Feature 13): dropped tools filtered from schema list.
// Feature 2: Query routing — filter write tools for read-only plan steps.
function getAllTools(config, stage2Category) {
  const tools = _getAllToolsModule(config, stage2Category, { pluginLoader, mcpClient: (typeof mcpClient !== 'undefined' ? mcpClient : null) });
  let filtered = tools;

  // Feature 2: if plan is active and current step is a query, filter write tools
  try {
    if (_planTracker && _planTracker.plan && _planTracker.currentStep < _planTracker.plan.length) {
      const { classifyAction, getToolsForActionType } = require('../src/session/action_classifier');
      const currentStepText = _planTracker.plan[_planTracker.currentStep];
      if (currentStepText) {
        const actionType = classifyAction(currentStepText);
        if (actionType === 'query') {
          filtered = getToolsForActionType('query', tools);
        }
      }
    }
  } catch {}

  try {
    const { getTrustDecay } = require('../src/tools/trust_decay');
    return getTrustDecay().filterAndSort(filtered);
  } catch {
    return filtered;
  }
}
let ALL_TOOLS = [...TOOLS, ...COMPOUND_TOOLS];

const MAX_TOOL_CALLS = 500;
const MAX_IMPROVE_ITERATIONS = 2;

// Estimate tokens for a message, properly accounting for tool_calls args
// which are stored as JSON strings inside the message but are NOT in .content.
function estimateMessageTokens(m) {
  let chars = 0;
  if (typeof m.content === 'string') {
    chars += m.content.length;
  } else if (m.content) {
    chars += JSON.stringify(m.content).length;
  }
  // tool_calls messages have arguments that consume tokens but aren't in .content
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      chars += (tc.function?.name?.length || 0) + (tc.function?.arguments?.length || 0) + 20;
    }
  }
  return Math.ceil(chars / 4);
}

function estimateHistoryTokens(history) {
  return history.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

async function runAgentLoop(userMessage, config) {
  // Reset early-stop state for new turn
  earlyStop.newTurn();

  // Reset per-turn idempotent-write dedup. PURE_TOOLS dedup uses a sliding
  // window across turns; this set is *per-turn* and stops `memory_remember`
  // (and friends) from being called with identical args repeatedly in a
  // single turn. See src/tools/dedup.js for the full rationale.
  try {
    const { newTurnIdempotentWriteSet } = require('../src/tools/dedup');
    newTurnIdempotentWriteSet();
  } catch {}

  // Start trace recording for this turn
  traceRecorder.start(userMessage, config.model.name);

  // Mark new turn in token monitor (next recordCall will start a new turn entry)
  tokenMonitor._nextCallIsNewTurn = true;

  // Feature 3: rate limiting — assert within budget before starting turn
  try {
    if (assertWithinBudget) assertWithinBudget('run_turn', {});
  } catch (e) {
    const msg = e.message || String(e);
    if (_fullscreenRef) _fullscreenRef.addTool('policy', 'err', msg);
    else console.log(`  \x1b[33m⚠ ${msg}\x1b[0m`);
    // Still proceed — rate limiting is advisory for local use
  }

  // Clarification loop — detect vague prompts before wasting tool calls.
  // MarrowScript Feature #1: uses compiled intent_clarifier (LLM-based, cached 30m)
  // with automatic fallback to regex when the model is unavailable.
  // Only fires on short messages (< 80 chars) — long messages are almost never vague
  // and we don't want to add 2s latency to every detailed task description.
  const { getClarificationInstruction } = require('../src/session/clarify');
  let _needsClarification = false;
  // Skip clarifier when the message is clearly actionable even if short:
  // - Looks like a file path (quoted, contains slash/backslash, has extension)
  // - Pure number or "option N" / "work on N" — context-reference to prior options
  // - Affirmation in continuation context (yes/ok/sure/proceed)
  // - ROOT CAUSE FIX: assistant's last turn ended with a question — user reply is an answer,
  //   not a new task. Evaluate messages in context, not in isolation.
  const lastAssistantMsg = [...conversationHistory].reverse().find(m => m.role === 'assistant');
  const assistantAskedQuestion = typeof lastAssistantMsg?.content === 'string' && lastAssistantMsg.content.trimEnd().endsWith('?');
  const looksLikePath = /[\\\/]|\.\w{1,5}\s*$|^["'].*["']$/.test(userMessage.trim());
  const looksLikeOptionRef = /^(option\s+\d|work\s+on\s+\d|do\s+\d|start\s+with\s+\d|^\d+\.?\s*$|first|second|third|fourth)\b/i.test(userMessage.trim());
  // Multi-number selection (e.g. "1 and 2", "1, 2", "both 1 and 2")
  const looksLikeMultiSelect = /^(both\s+)?\d+(\s*,\s*|\s+and\s+)\d+$/i.test(userMessage.trim());
  const looksLikeAffirmation = (
    /^(yes|y|yep|yeah|sure|ok|okay|go|proceed|do it|continue|please|alright|👍|✅)\b\s*\.?\s*$/i.test(userMessage.trim()) ||
    // Multi-word continuations: "go ahead", "go ahead and read it", "read it", "do that", "that one"
    /^(go ahead|go for it|just do it|do that|do both|read it|show me|that one|sounds good|let's do it|let's go|that works)\b/i.test(userMessage.trim())
  );
  if (userMessage.length < 80 && !assistantAskedQuestion && !looksLikePath && !looksLikeOptionRef && !looksLikeMultiSelect && !looksLikeAffirmation) {
    try {
      const { checkNeedsClarification } = require('./features_adapter');
      _needsClarification = await checkNeedsClarification(userMessage);
    } catch {
      const { needsClarification } = require('../src/session/clarify');
      _needsClarification = needsClarification(userMessage);
    }
  }
  if (_needsClarification) {
    // Inject clarification instruction into this turn only — record the index
    // so we can splice it out after the model responds, otherwise it persists
    // in history and re-fires on every subsequent turn.
    conversationHistory.push({ role: 'user', content: userMessage });
    const _clarifierIdx = conversationHistory.length;
    conversationHistory.push({ role: 'system', content: getClarificationInstruction() });
    const response = await chatCompletion(config, conversationHistory);
    // Always remove the one-shot clarifier instruction whether the model responded or not
    if (_clarifierIdx >= 0 && _clarifierIdx < conversationHistory.length) {
      const msg = conversationHistory[_clarifierIdx];
      if (msg && msg.role === 'system' && typeof msg.content === 'string' &&
          msg.content.includes('vague')) {
        conversationHistory.splice(_clarifierIdx, 1);
      }
    }
    const message = response?.choices?.[0]?.message;
    if (message?.content) {
      conversationHistory.push({ role: 'assistant', content: message.content });
      if (_fullscreenRef) {
        _fullscreenRef.addChat('assistant', message.content);
      } else {
        process.stdout.write(tui.renderMarkdown(message.content));
      }
    }

    // One-question policy: model asked its question AND started working.
    // If the model already issued tool calls in its clarification response,
    // fall through to the main agent loop below to continue executing.
    // If it only asked a question (no tool calls), fall through anyway —
    // the model will continue on its best interpretation next turn.
    // Do NOT return here — the dev loop must continue.
    if (message?.tool_calls?.length > 0) {
      // Model already started working — the main loop below will pick up
      // the tool calls from this response. Reconstruct userMessage for the
      // main loop by using what's already in conversationHistory.
      // Fall through to main agent loop.
    } else {
      // Model asked its question but didn't start working yet.
      // In interactive mode, show the question and wait for the next user turn.
      // The clarifier will NOT re-fire next turn (assistantAskedQuestion guard).
      return;
    }
  }

  // Detect drag-and-dropped image files (bare path pasted into terminal)
  const { detectDroppedFile } = require('../src/session/images');
  const droppedPath = detectDroppedFile(userMessage);
  if (droppedPath) {
    // Convert bare path into an @reference prompt
    userMessage = `@${droppedPath} — I dropped this image. What would you like me to do with it?`;
    if (_fullscreenRef) _fullscreenRef.addTool('image', 'ok', `attached: ${path.basename(droppedPath)}`);
  }

  // Resolve @file references in user input
  const { text, files } = resolveReferences(userMessage, process.cwd());
  let augmented = files.length > 0
    ? text + formatReferencesForPrompt(files)
    : text;

  // Auto-inject git diff when message implies recent changes
  if (shouldInjectGitContext(userMessage)) {
    const gitCtx = getGitDiffContext(process.cwd(), 80);
    if (gitCtx) augmented += gitCtx;
  }

  conversationHistory.push({ role: 'user', content: augmented });

  // Open a snapshot checkpoint for this agent run (Feature 9). All
  // write_file/patch calls during this run will record their pre-edit
  // state. On clean completion we commit (discard); on hard failure with
  // SMALLCODE_SNAPSHOT_AUTO_ROLLBACK=true we revert all writes.
  try {
    const { getSnapshotManager } = require('../src/session/snapshot');
    const snap = getSnapshotManager({ workdir: process.cwd() });
    snap.begin(`turn-${Date.now()}`);
  } catch {}

  // Plan-then-execute (Feature 8): for multi-step tasks, ask the model for
  // a numbered plan FIRST, then re-inject it as an anchor on subsequent
  // turns so it doesn't drift. Heuristic-based — single-shot tasks like
  // "create hello.py" don't trigger planning.
  let _planInstructionIdx = -1; // track the one-shot instruction so we can remove it
  try {
    const { shouldPlan, PlanTracker } = require('../src/session/plan_tracker');
    if (!_planTracker) _planTracker = new PlanTracker();
    _planTracker.reset();
    if (shouldPlan(userMessage)) {
      _planTracker.activate();
      // Append a one-shot instruction asking the model to emit a plan first.
      // We record the index so we can splice it out after the first response
      // — it must not persist in history and be re-sent on every subsequent call.
      _planInstructionIdx = conversationHistory.length;
      conversationHistory.push({
        role: 'system',
        content: PlanTracker.planRequestInstruction(),
      });
    }
  } catch {} // never fail the agent loop on planner errors

  // Initialise per-run detectors (Features 10-11) bound to THIS workdir.
  // Re-created each run so bench tasks running in temp dirs get correct info.
  try {
    const { BootstrapDetector } = require('../src/session/bootstrap');
    _bootstrapDetector = new BootstrapDetector({ workdir: process.cwd() });
  } catch { _bootstrapDetector = null; }
  try {
    const { TestRunnerDetector } = require('../src/tools/test_runner');
    _testRunnerDetector = new TestRunnerDetector({ workdir: process.cwd() });
  } catch { _testRunnerDetector = null; }
  // Knowledge loader (Feature 4) also per-run so bench tasks get their own workdir.
  try {
    const { KnowledgeLoader } = require('../src/knowledge/loader');
    _knowledgeLoader = new KnowledgeLoader({ rootDir: process.cwd() });
  } catch { _knowledgeLoader = null; }
  // Trust decay (Feature 13) resets per agent loop turn so TUI sessions
  // don't accumulate decay from unrelated prior requests.
  try {
    const { getTrustDecay } = require('../src/tools/trust_decay');
    getTrustDecay().reset();
  } catch {}

  // Multi-model chaining (Feature #15): async call to planner model to pre-
  // generate a numbered plan. Runs concurrently with task classification since
  // both are pure network calls — we await it just before the first chatCompletion.
  // Only fires when SMALLCODE_CHAIN=true, a planner model is configured, and the
  // task looks complex enough to benefit from pre-planning (fast tasks skip it).
  let _plannerPromise = null;
  try {
    const { callPlanner, getChainConfig } = require('../src/model/chain');
    const { estimateComplexity } = require('../src/model/router');
    const cc = getChainConfig();
    if (cc.enabled && cc.planner && estimateComplexity(userMessage) !== 'fast') {
      _plannerPromise = callPlanner(userMessage, config);
    }
  } catch {}

  // Governor: classify task type (determines verification strategy)
  // Uses MarrowScript-compiled classifier with regex fallback
  try {
    currentTaskType = await classifyTaskAsync(userMessage);
  } catch {
    currentTaskType = classifyTask(userMessage);
  }

  // Deterministic tool routing: classify intent → filter tool schemas
  // Zero tokens, zero latency — compiled from marrow/tool_router.marrow
  try {
    const { classifyToolCategory, categoryNeedsTools } = require('../src/compiled/tool_router');
    // Affirmation guard: short confirmation messages (yes/ok/sure/go/proceed/
    // option N / work on N / first/second/etc.) should NOT reclassify the turn
    // as 'respond' — that would strip all tools right after the model proposed
    // an action it now wants to execute. Keep the prior turn's category so the
    // model still has the right tools available.
    const trimmedMsg = userMessage.trim();
    const isAffirmation = /^(yes|y|yep|yeah|sure|ok|okay|go|proceed|do it|continue|please|please do|alright|👍|✅)\b\s*\.?\s*$/i.test(trimmedMsg);
    const isContinuationRef = /^(option\s+\d|work\s+on\s+\d|do\s+\d|start\s+with\s+\d|\d+\.?\s*$|first|second|third|fourth|that|this|the\s+last|next)\b/i.test(trimmedMsg) && trimmedMsg.length < 30;
    const shouldKeepCategory = isAffirmation || isContinuationRef;
    if (shouldKeepCategory && currentToolCategory && currentToolCategory !== 'respond') {
      // Keep the existing category — don't re-classify
      if (_fullscreenRef) _fullscreenRef.addTool('router', 'ok', `${currentToolCategory} (kept — continuation)`);
    } else {
      const routeResult = classifyToolCategory(userMessage);
      // If user said yes/ok/option-N and the previous category was respond/null,
      // default to 'plan' which gives a broad tool set so the model can execute.
      if (shouldKeepCategory && (!currentToolCategory || currentToolCategory === 'respond')) {
        currentToolCategory = 'plan';
        if (_fullscreenRef) _fullscreenRef.addTool('router', 'ok', `plan (continuation default)`);
      } else {
        currentToolCategory = routeResult.category;
        if (_fullscreenRef && routeResult.confidence > 0.3) {
          _fullscreenRef.addTool('router', 'ok', `${routeResult.category} (${Math.round(routeResult.confidence * 100)}%)`);
        }
      }
    }
  } catch {
    currentToolCategory = null; // Fall back to all tools
  }

  // Feature 5: retrieve_context — auto-inject relevant files via code graph
  // Zero LLM calls; walks symbol graph from user message keywords
  try {
    if (retrieveContext && mcpCall) {
      const ctx = await retrieveContext(userMessage, mcpCall, 6);
      if (ctx && ctx.files && ctx.files.length > 0) {
        const contextHint = `[Auto-context: relevant files detected — ${ctx.files.slice(0, 4).join(', ')}]`;
        // Inject as a system hint into the last user message (non-intrusive)
        const lastUser = conversationHistory[conversationHistory.length - 1];
        if (lastUser && lastUser.role === 'user' && typeof lastUser.content === 'string') {
          lastUser.content = lastUser.content + '\n\n' + contextHint;
        }
        if (_fullscreenRef) _fullscreenRef.addTool('context', 'ok', `${ctx.files.length} files, ${ctx.symbols.length} symbols`);
      }
    }
  } catch {} // Never block on context retrieval

  // Multi-model routing: pick model based on task complexity (if configured)
  // Phase C: Marrowscript-compiled coding_router for tier-based dispatch.
  // Falls back to hand-rolled routeModel() if compiled router unavailable.
  if (config.models || process.env.SMALLCODE_USE_TIER_ROUTING === 'true') {
    let selectedModel = null;
    let selectedTier = null;
    try {
      const { routeToTier, estimateComplexity, isCompiledCognitionAvailable } = require('./cognition_adapter');
      if (isCompiledCognitionAvailable()) {
        const complexity = estimateComplexity(userMessage);
        const route = routeToTier(complexity);
        if (route) {
          // Map model_id back to actual model name from config.models if set,
          // otherwise use the SMALLCODE_MODEL env var (already configured per tier).
          if (config.models) {
            if (route.tier === 'trivial') selectedModel = config.models.fast;
            else if (route.tier === 'simple') selectedModel = config.models.default;
            else selectedModel = config.models.strong;
          }
          selectedTier = route.tier;
        }
      }
    } catch {}

    // Fallback: hand-rolled routeModel
    if (!selectedModel && config.models) {
      selectedModel = routeModel(userMessage, config);
    }

    if (selectedModel && selectedModel !== config.model.name) {
      config.model.name = selectedModel;
      if (_fullscreenRef) _fullscreenRef.addTool('router', 'ok', `→ ${selectedModel}${selectedTier ? ' (' + selectedTier + ')' : ''}`);
    }
  }

  // Auto-compact: estimate tokens and aggressively trim to stay within context window
  // Fix: trigger on EITHER token overflow OR message count (not just one condition for both).
  // For small-context models (8k-16k) the token check matters most.
  const estimatedTokens = estimateHistoryTokens(conversationHistory);
  const maxContextTokens = (config.context?.detected_window || 128000) * ((config.context?.max_budget_pct || 70) / 100);

  if (estimatedTokens > maxContextTokens * 0.8 || conversationHistory.length > 30) {
    // Phase B: Try MarrowScript-compiled compress_history first.
    // It produces a semantic summary instead of just dropping messages.
    let compressedSuccessfully = false;
    if (conversationHistory.length > 10) {
      try {
        const { compressHistoryCompiled, isCompiledCognitionAvailable } = require('./cognition_adapter');
        if (isCompiledCognitionAvailable()) {
          // Take oldest non-system messages, leave most recent 6 intact
          const recentCount = 6;
          const oldStart = conversationHistory.findIndex(m => m.role !== 'system');
          const oldEnd = conversationHistory.length - recentCount;
          if (oldStart >= 0 && oldEnd > oldStart) {
            const oldMessages = conversationHistory.slice(oldStart, oldEnd);
            const oldSerialized = oldMessages
              .map(m => {
                const role = m.role || 'unknown';
                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
                return `[${role}] ${content.slice(0, 1500)}`;
              })
              .join('\n\n');
            const targetTokens = Math.max(200, Math.min(1500, Math.floor(maxContextTokens * 0.05)));
            const summary = await compressHistoryCompiled(oldSerialized, targetTokens);
            if (summary && summary.length > 0) {
              // Replace old messages with a single summary system message
              conversationHistory.splice(oldStart, oldEnd - oldStart, {
                role: 'system',
                content: `[Compressed summary of ${oldMessages.length} earlier messages]\n${summary}`,
              });
              compressedSuccessfully = true;
              console.log(tui.compacted(conversationHistory.length));
            }
          }
        }
      } catch {}
    }

    // Fallback: drop oldest non-system messages until under budget
    if (!compressedSuccessfully) {
      while (conversationHistory.length > 6) {
        const currentEst = estimateHistoryTokens(conversationHistory);
        // Fix #19: Always compact until under 70% of budget. The old condition
        // `&& conversationHistory.length <= 20` would stop compacting at 20
        // messages even if still way over budget (e.g. 20 messages of 2000 tokens each).
        if (currentEst < maxContextTokens * 0.7) break;
        const removeIdx = conversationHistory.findIndex(m => m.role !== 'system');
        if (removeIdx === -1) break;
        conversationHistory.splice(removeIdx, 1);
      }
      const summary = `[Context compacted to fit ${Math.round(maxContextTokens)} token budget]`;
      conversationHistory.unshift({ role: 'system', content: summary });
      console.log(tui.compacted(conversationHistory.length));
    }
  }

  let toolCallsThisTurn = 0;
  let _editedFilesThisTurn = []; // track files written/patched for reviewer
  let _reviewerPromise = null;   // reviewer async promise, awaited at turn end

  // Await planner result (Feature #15) and inject into conversation as a system
  // message if it produced a valid plan. This happens ONCE before the first
  // chatCompletion call — the await here is cheap since we started the request
  // concurrently with task classification above.
  let _plannerInjected = false;
  try {
    if (_plannerPromise) {
      const plan = await _plannerPromise;
      if (plan) {
        const { formatPlannerInjection } = require('../src/model/chain');
        const injection = formatPlannerInjection(plan);
        if (injection) {
          conversationHistory.push({ role: 'system', content: injection });
          _plannerInjected = true;
          if (_fullscreenRef) _fullscreenRef.addTool('chain', 'ok', `planner: ${plan.split('\n').length} steps`);
        }
      }
    }
  } catch {}

  while (toolCallsThisTurn < MAX_TOOL_CALLS) {
    // Mid-turn context check: if history is getting too large, evict old tool results
    // This prevents context overflow during long tool-call chains
    if (toolCallsThisTurn > 0 && toolCallsThisTurn % 3 === 0) {
      let midEst = estimateHistoryTokens(conversationHistory);
      const maxBudget = (config.context?.detected_window || 128000) * 0.6;
      if (midEst > maxBudget) {
        // Fix #14: First pass — truncate large tool_call arguments in OLD assistant
        // messages (not the most recent one). After the tool result has been received,
        // the model doesn't need the full write_file content in arguments anymore.
        const lastAssistantIdx = conversationHistory.reduce((last, m, i) => m.tool_calls ? i : last, -1);
        for (let i = 0; i < lastAssistantIdx; i++) {
          const m = conversationHistory[i];
          if (!m.tool_calls) continue;
          for (const tc of m.tool_calls) {
            if (tc.function && tc.function.arguments && tc.function.arguments.length > 200) {
              const saved = tc.function.arguments.length;
              // Replace with minimal valid JSON that preserves the tool name context.
              // Defensive: if arguments are already invalid JSON (from a prior truncation
              // pass that produced '...' suffixes), just replace with '{}' directly.
              try {
                const parsed = JSON.parse(tc.function.arguments);
                const minimal = {};
                for (const [k, v] of Object.entries(parsed)) {
                  if (typeof v === 'string' && v.length > 100) {
                    minimal[k] = v.slice(0, 80) + '…';
                  } else {
                    minimal[k] = v;
                  }
                }
                tc.function.arguments = JSON.stringify(minimal);
              } catch {
                // Already invalid JSON — reset to empty object to avoid cascading
                // parse failures on subsequent passes or API calls.
                tc.function.arguments = '{}';
              }
              midEst -= Math.ceil((saved - tc.function.arguments.length) / 4);
            }
          }
        }

        let evicted = 0;
        for (let i = 0; i < conversationHistory.length && midEst > maxBudget * 0.7; i++) {
          if (conversationHistory[i].role === 'tool') {
            const tcId = conversationHistory[i].tool_call_id;
            // Only evict if the corresponding assistant message was also evicted
            // (i.e. its tool_call_id is no longer referenced). To be safe in
            // one pass, we evict tool+assistant pairs from the oldest end:
            // find the assistant message that owns this tool result.
            let ownerIdx = -1;
            for (let j = i - 1; j >= 0; j--) {
              if (conversationHistory[j].tool_calls &&
                  conversationHistory[j].tool_calls.some(tc => tc.id === tcId)) {
                ownerIdx = j;
                break;
              }
            }
            // Only evict if the owner is in the first half of history (old enough)
            // AND we can remove the pair together. Otherwise skip to avoid orphaning.
            if (ownerIdx >= 0 && ownerIdx < conversationHistory.length / 2) {
              // Replace the tool result with a compact summary
              const content = conversationHistory[i].content || '';
              const len = Math.ceil(content.length / 4);
              conversationHistory[i].content = `[evicted: ${len} tokens]`;
              midEst -= len - 5;
              evicted++;
            } else if (ownerIdx === -1) {
              // Orphaned tool result (owner already gone) — safe to remove
              const len = Math.ceil((conversationHistory[i].content || '').length / 4);
              conversationHistory.splice(i, 1);
              midEst -= len;
              evicted++;
              i--;
            }
          }
        }
        if (evicted > 0) tokenMonitor.recordEviction();
      }
    }

    const response = await chatCompletion(config, conversationHistory);

    if (!response) {
      console.log('  \x1b[31m✗ No response from model\x1b[0m');
      break;
    }

    const message = response.choices?.[0]?.message;
    if (!message) break;

    // Defensive recovery: some local models (qwen2.5-coder, hermes, llama3
    // GGUFs) emit tool calls as JSON inside `content` instead of populating
    // structured `tool_calls`. Try to lift them into the proper field
    // before any downstream logic looks at the message. Issue #36.
    try {
      const { extractFromMessage } = require('../src/tools/tool_call_extractor');
      const r = extractFromMessage(message, getAllTools(config, currentToolCategory));
      if (r.patched && _fullscreenRef) {
        _fullscreenRef.addTool('tool_call', 'ok', `recovered ${r.addedCalls} from text content`);
      }
    } catch {}

    // Truncate excessive thinking content before it enters conversation history.
    // Reasoning models can ignore the soft budget and emit 50KB of thinking
    // loops. We hard-cap it here so the next turn doesn't include a wall of
    // <think>...</think>. Pure replacement — content stays a string.
    if (message.content && typeof message.content === 'string') {
      try {
        const { truncateThinking, estimateThinkingTokens } = require('../src/model/thinking_budget');
        const beforeTokens = estimateThinkingTokens(message.content);
        message.content = truncateThinking(message.content);
        const afterTokens = estimateThinkingTokens(message.content);
        if (beforeTokens > 1000 && _fullscreenRef) {
          _fullscreenRef.addTool('thinking', afterTokens < beforeTokens ? 'err' : 'ok',
            `${beforeTokens}t${afterTokens < beforeTokens ? ` → ${afterTokens}t (truncated)` : ''}`);
        }
      } catch {}
    }

    // If model wants to call tools
    if (message.tool_calls && message.tool_calls.length > 0) {
      // After first tool call, widen tool set for subsequent iterations.
      // If the model just called select_category, currentToolCategory was already
      // set to the selected category by the handler below. Otherwise, widen to
      // 'plan' which in the compiled router maps to all essential tools.
      const firstToolName = message.tool_calls[0]?.function?.name;
      if (firstToolName !== 'select_category') {
        currentToolCategory = 'plan';
      }

      // Add assistant message with tool calls to history.
      // Fix #14: We store the ORIGINAL message here (it must have valid JSON args
      // for the next API call to work). The context savings come from the mid-turn
      // eviction and compaction logic, not from corrupting args mid-conversation.
      // However, once a tool_call has been fully processed (tool result received),
      // we'll truncate large args in the stored message during mid-turn eviction.
      //
      // Poisoned-history fix: snapshot history length BEFORE pushing the assistant
      // message + tool results. If every tool call in this turn returns a validation
      // error, we revert to this length and inject a single user-role correction —
      // preventing the model's malformed output from biasing the retry.
      const __preTurnHistoryLen = conversationHistory.length;
      const __validationErrors = [];

      conversationHistory.push(message);

      // Plan extraction (Feature 8): if the model emitted a plan in its
      // textual content, capture it now so subsequent turns can re-inject it.
      try {
        if (_planTracker && _planTracker.needsPlan() && message.content) {
          // MarrowScript Feature #3: use async LLM-based plan extractor with regex fallback
          if (await _planTracker.ingestResponseAsync(message.content)) {
            if (_fullscreenRef) _fullscreenRef.addTool('plan', 'ok', `${_planTracker.plan.length} steps`);
            // Remove the one-shot instruction now that we have the plan.
            // It must not persist in history or the model will keep trying
            // to write a plan on every subsequent chatCompletion call.
            if (_planInstructionIdx >= 0 && _planInstructionIdx < conversationHistory.length) {
              const msg = conversationHistory[_planInstructionIdx];
              if (msg && msg.role === 'system' && typeof msg.content === 'string' &&
                  msg.content.includes('numbered plan')) {
                conversationHistory.splice(_planInstructionIdx, 1);
              }
              _planInstructionIdx = -1;
            }

            // Feature 4: validate file paths mentioned in the plan.
            // Advisory only — injects a warning system message so the model
            // can self-correct via find_files rather than hard-failing.
            try {
              const { validatePlanPaths, buildDependencyGraph, toParallelBatches, formatBatchSummary } = require('../src/session/dependency_graph');
              const { missing } = validatePlanPaths(_planTracker.plan, process.cwd());
              if (missing.length > 0) {
                const warnMsg = `[PATH-VALIDATION] Plan references files that don't exist on disk: ${missing.join(', ')}. ` +
                  `Use find_files or bash to locate the correct paths before proceeding.`;
                conversationHistory.push({ role: 'system', content: warnMsg });
                if (_fullscreenRef) _fullscreenRef.addTool('warning', 'warn', `missing paths: ${missing.join(', ')}`);
              }

              // Feature 3: build dependency graph and log batch structure to TUI
              const graph = buildDependencyGraph(_planTracker.plan, process.cwd());
              const batches = toParallelBatches(graph, _planTracker.plan.length);
              _planTracker._executionBatches = batches;
              if (_fullscreenRef && batches.length > 0) {
                _fullscreenRef.addTool('plan', 'ok', formatBatchSummary(batches));
              }
            } catch {}
          }
        }
      } catch {}

      for (const tc of message.tool_calls) {
        toolCallsThisTurn++;
        const toolName = tc.function.name;
        let toolArgs;
        try {
          toolArgs = JSON.parse(tc.function.arguments);
        } catch {
          // Feature 1: repair malformed tool args via compiled repair_tool_call prompt
          let repaired = false;
          if (repairToolCall) {
            try {
              const toolDef = ALL_TOOLS.find(t => t.function.name === toolName);
              const schema = toolDef ? JSON.stringify(toolDef.function.parameters).slice(0, 500) : '';
              const repair = await repairToolCall(tc.function.arguments, 'Invalid JSON', schema);
              if (repair.ok && repair.repairedCall) {
                try {
                  toolArgs = JSON.parse(repair.repairedCall);
                  repaired = true;
                  if (_fullscreenRef) _fullscreenRef.addTool('repair', 'ok', `repaired ${toolName} args`);
                } catch {}
              }
            } catch {}
          }
          if (!repaired) {
            // Last-resort fallback for write_file: try regex extraction of path + content
            // before giving up entirely. The most common failure mode is a large file
            // content with unescaped quotes that breaks JSON.parse — we can often still
            // extract the path and a truncated content.
            if (toolName === 'write_file' && typeof tc.function.arguments === 'string') {
              try {
                const raw = tc.function.arguments;
                const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/);
                const contentMatch = raw.match(/"content"\s*:\s*"([\s\S]+?)(?=",\s*"|\s*}\s*$)/);
                if (pathMatch) {
                  // Unescape basic JSON escape sequences
                  const unescape = s => s
                    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '')
                    .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                  toolArgs = {
                    path: pathMatch[1],
                    content: contentMatch ? unescape(contentMatch[1]) : '',
                  };
                  repaired = true;
                  if (_fullscreenRef) _fullscreenRef.addTool('repair', 'ok', `regex-extracted write_file args`);
                  else console.log(`  \x1b[33m⚠ Repaired write_file args via regex extraction\x1b[0m`);
                }
              } catch {}
            }
            if (!repaired) {
              toolArgs = {};
              console.log(`  \x1b[31m✗ Failed to parse args for ${toolName}\x1b[0m`);
            }
          }
        }

        // Show what's happening
        process.stdout.write(tui.toolStart(toolName));
        const toolStart2 = Date.now();

        const result = await executeTool(toolName, toolArgs);
        const toolMs = Date.now() - toolStart2;

        // Track validation errors so the poisoned-history fix can revert
        // bad assistant turns where the model emitted malformed tool args.
        if (result && result.kind === 'validation') {
          __validationErrors.push(`${toolName}: ${result.error}`);
        }

        // Handle select_category: update the tool category so the NEXT
        // chatCompletion call injects the right tool schemas for stage 2.
        if (toolName === 'select_category' && result.category) {
          currentToolCategory = result.category;
        }

        // Record trace step
        traceRecorder.recordToolCall(toolName, toolArgs, result.result || result.error || '', toolMs);

        // Track edited files for reviewer agent (Feature #18)
        if ((toolName === 'write_file' || toolName === 'patch') && !result.error && toolArgs.path) {
          _editedFilesThisTurn.push(toolArgs.path);
          // MarrowScript Rank 6: inject multi-file coordination header when editing 3+ files
          if (_editedFilesThisTurn.length >= 3) {
            try {
              const { coordinateMultiFileEdit } = require('../src/compiled/features/multi_file_edit');
              const { getSnapshotManager } = require('../src/session/snapshot');
              const snap = getSnapshotManager({ workdir: process.cwd() });
              await coordinateMultiFileEdit(userMessage, _editedFilesThisTurn, conversationHistory, executeTool, snap);
            } catch {} // never block on coordination errors
          }
        }

        // Trust decay (Feature 13): track consecutive failures per tool.
        // Dropped tools are filtered out of the schema list on the next
        // chatCompletion via getAllTools() → filterAndSort().
        try {
          const { getTrustDecay } = require('../src/tools/trust_decay');
          getTrustDecay().record(toolName, !result.error);
        } catch {}

        // Show result indicators
        if (result.error) {
          console.log(tui.toolError(result.error));
        } else if (result.action === 'Created') {
          console.log(tui.toolCreated(result.path, result.lines, toolMs));
        } else if (result.action === 'Updated') {
          console.log(tui.toolUpdated(result.path, result.lines, toolMs));
        } else if (result.action === 'Edited') {
          console.log(tui.toolEdited(result.path, result.line, toolMs));
        } else if (result.command) {
          console.log(tui.toolBash(result.command, toolMs));
        } else {
          console.log(tui.toolSuccess('', toolMs));
        }

        // Add tool result to history (cap to prevent context explosion)
        // Add tool result to history (cap to prevent context explosion).
        // 8k chars (~2k tokens) fits ~240 lines, so most source files come
        // back in a single read_file. Lower caps force multi-read sequences,
        // each costing a full LLM turn. Mid-turn eviction is the safety net
        // if total context still grows too large.
        // Override with SMALLCODE_MAX_TOOL_RESULT_CHARS env var.
        const toolContent = result.result || result.error || '';
        const maxToolResultChars = parseInt(process.env.SMALLCODE_MAX_TOOL_RESULT_CHARS) || 8000;
        const cappedContent = toolContent.length > maxToolResultChars
          ? toolContent.slice(0, maxToolResultChars - 200) + '\n\n...(truncated, ' + toolContent.length + ' chars total)...\n' + toolContent.slice(-200)
          : toolContent;
        conversationHistory.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: cappedContent,
        });

        // ── IMPROVEMENT LOOP: auto-validate writes and feed errors back ──
        // Uses MarrowScript-compiled bounded loop for iteration control + tracing
        if ((toolName === 'write_file' || toolName === 'patch') && !result.error) {
          const filePath = toolArgs.path;

          // Feature 6: self-critique the edit before running lint
          try {
            if (validateEditCompiled && filePath) {
              const written = fs.existsSync(path.resolve(process.cwd(), filePath))
                ? fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8')
                : (toolArgs.content || '');
              const critique = await validateEditCompiled(filePath, written, userMessage);
              if (!critique.ok && critique.issues.length > 0) {
                if (_fullscreenRef) _fullscreenRef.addTool('critique', 'err', critique.issues[0].slice(0, 80));
                // Inject semantic issue as additional context for the improvement loop
                conversationHistory.push({ role: 'user', content: `[SEMANTIC-REVIEW] Potential issue in ${filePath}: ${critique.issues[0]}` });
              }
            }
          } catch {} // Never block on self-critique

          const validation = runValidation(filePath);
          if (validation && !validation.passed) {
            // Track how many times we've tried fixing this file
            if (!improvementAttempts[filePath]) improvementAttempts[filePath] = 0;
            improvementAttempts[filePath]++;

            // Token monitor: record validation failure (counts as improvement overhead)
            tokenMonitor.recordCompaction(); // Reuse compaction counter for improvement overhead tracking

            if (improvementAttempts[filePath] <= MAX_IMPROVE_ITERATIONS) {
              const attempt = improvementAttempts[filePath];
              console.log(tui.improvementLoop(validation.errors, attempt, MAX_IMPROVE_ITERATIONS));

              // Track attempt history for this file
              if (!improvementAttempts[`__history:${filePath}`]) improvementAttempts[`__history:${filePath}`] = [];
              improvementAttempts[`__history:${filePath}`].push({
                attempt,
                errors: validation.errors.slice(0, 3),
              });

              // Build fix prompt with full retry history
              let fixPrompt;
              const history = improvementAttempts[`__history:${filePath}`];
              const historyStr = history.length > 1
                ? `\n\nPrevious attempts (${history.length - 1} failed):\n` + history.slice(0, -1).map((h, i) => `  Attempt ${i + 1}: ${h.errors[0] || 'unknown error'}`).join('\n')
                : '';

              if (attempt <= 2) {
                // Include the test command if we have one, so the model can verify its own fix
                let testHint = '';
                try {
                  if (_testRunnerDetector) {
                    const r = _testRunnerDetector.detect();
                    if (r) testHint = `\n\nAfter fixing, run \`${r.command}\` to verify.`;
                  }
                } catch {}
                fixPrompt = `[AUTO-VALIDATE] Errors in ${filePath} (attempt ${attempt}/${MAX_IMPROVE_ITERATIONS}):
${validation.errors.join('\n')}${historyStr}${testHint}

Fix these errors. Do NOT repeat the same approach that failed before.`;
              } else {
                // Escalated: show the full file + errors + history
                // CAP file content to ~2000 tokens (8000 chars) to prevent context blow-up.
                // On small-context models (8k-16k) injecting a 5000-line file is fatal.
                let fileContent = '';
                try { fileContent = fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8'); } catch {}
                const maxFileChars = Math.min(8000, Math.floor(((config.context?.detected_window || 32768) * 0.15) * 4));
                const cappedFile = fileContent.length > maxFileChars
                  ? fileContent.slice(0, maxFileChars) + `\n... (${Math.ceil((fileContent.length - maxFileChars)/4)} more tokens truncated)`
                  : fileContent;
                fixPrompt = `[AUTO-VALIDATE] After ${attempt} attempts, ${filePath} still has errors.${historyStr}

FULL FILE CONTENT:
\`\`\`
${cappedFile}
\`\`\`

ERRORS:
${validation.errors.join('\n')}

Read the FULL file above carefully. Fix ALL errors. Use the patch tool with the exact text from the file. Do NOT repeat previous failed approaches.`;
              }

              conversationHistory.push({ role: 'user', content: fixPrompt });
            } else {
              // DECOMPOSE instead of giving up — break the problem into chunks
              improvementAttempts[filePath] = 0;
              let fileContent = '';
              try { fileContent = fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8'); } catch {}

              // MarrowScript Rank 5: try LLM-based decompose strategy first
              let strategy;
              try {
                const { decomposeTask } = require('./features_adapter');
                if (decomposeTask) {
                  const errStr = validation.errors.join('\n');
                  const decomposeResult = await decomposeTask(userMessage, errStr, fileContent.slice(0, 1000));
                  if (decomposeResult) strategy = { type: decomposeResult.strategy, reason: decomposeResult.reason, instruction: decomposeResult.instruction };
                }
              } catch {}
              // Fall back to governor's regex strategy
              if (!strategy) {
                const { pickDecomposeStrategy } = require('./governor');
                strategy = pickDecomposeStrategy(fileContent, validation.errors, filePath);
              }
              
              // Track decompose attempts — if this is the 2nd decompose, escalate instead
              if (!improvementAttempts[`__decompose:${filePath}`]) improvementAttempts[`__decompose:${filePath}`] = 0;
              improvementAttempts[`__decompose:${filePath}`]++;

              if (improvementAttempts[`__decompose:${filePath}`] >= 2 && escalationEngine && escalationEngine.canEscalate()) {
                // Decompose has been tried and failed — ESCALATE to stronger model
                console.log(`  \x1b[35m⬆ ESCALATING to ${escalationEngine.provider} (${escalationEngine.model}) — local model exhausted\x1b[0m`);
                
                // Cap file content for escalation to prevent context overflow on the
                // escalation model too (which has its own context limit).
                const maxEscFileChars = 12000;
                const cappedEscFile = fileContent.length > maxEscFileChars
                  ? fileContent.slice(0, maxEscFileChars) + `\n... (truncated, ${fileContent.split('\n').length} lines total)`
                  : fileContent;
                const escalationPrompt = `Fix these errors in ${filePath}. The code:\n\`\`\`\n${cappedEscFile}\n\`\`\`\n\nErrors:\n${validation.errors.join('\n')}\n\nPrevious attempts failed. Fix it correctly.`;
                const escalationMessages = [
                  ...conversationHistory.slice(-6), // Recent context
                  { role: 'user', content: escalationPrompt },
                ];
                
                const escalatedResponse = await escalationEngine.escalate(escalationMessages, ALL_TOOLS);
                
                if (escalatedResponse && !escalatedResponse.error) {
                  // Inject the escalated response back into the conversation
                  if (escalatedResponse.tool_calls) {
                    conversationHistory.push(escalatedResponse);
                    // Execute the escalated model's tool calls
                    for (const tc of escalatedResponse.tool_calls) {
                      const eName = tc.function.name;
                      let eArgs;
                      try { eArgs = JSON.parse(tc.function.arguments); } catch { eArgs = {}; }
                      process.stdout.write(`  \x1b[35m⬆\x1b[0m `);
                      process.stdout.write(tui.toolStart(eName));
                      const eResult = await executeTool(eName, eArgs);
                      if (eResult.error) {
                        console.log(tui.toolError(eResult.error));
                      } else if (eResult.action) {
                        console.log(tui.toolSuccess(`${eResult.action} ${eResult.path || ''}`, 0));
                      } else {
                        console.log(tui.toolSuccess('', 0));
                      }
                      conversationHistory.push({ role: 'tool', tool_call_id: tc.id, content: eResult.result || eResult.error || '' });
                    }
                  } else if (escalatedResponse.content) {
                    conversationHistory.push({ role: 'assistant', content: escalatedResponse.content });
                    process.stdout.write(tui.renderMarkdown(escalatedResponse.content));
                  }
                  improvementAttempts[`__decompose:${filePath}`] = 0;
                } else {
                  // Escalation also failed — give up gracefully
                  const errMsg = escalatedResponse?.error || 'No response';
                  console.log(`  \x1b[31m✗ Escalation failed: ${errMsg}\x1b[0m`);
                  // Auto-rollback (Feature 9, opt-in via SMALLCODE_SNAPSHOT_AUTO_ROLLBACK=true).
                  // Validation has hard-failed and even the stronger model couldn't fix it
                  // — better to revert to a known-good state than leave half-broken files.
                  try {
                    const { getSnapshotManager } = require('../src/session/snapshot');
                    const snap = getSnapshotManager();
                    if (snap.autoRollback && snap.isActive()) {
                      const r = snap.rollback('escalation+improvement-loop exhausted');
                      console.log(`  \x1b[33m↶ Auto-rollback: restored ${r.restored}, deleted ${r.deleted}\x1b[0m`);
                      conversationHistory.push({
                        role: 'user',
                        content: `[AUTO-ROLLBACK] All edits in this turn have been reverted because validation kept failing. The workspace is back to its pre-turn state. Re-read files before retrying.`,
                      });
                    }
                  } catch {}
                  conversationHistory.push({
                    role: 'user',
                    content: `[ESCALATION FAILED] Even the stronger model couldn't fix this. Deliver the best version you have and explain what's still broken.`,
                  });
                }
              } else {
                // First decompose attempt — try the local model with a new strategy
                console.log(`  \x1b[33m◇ DECOMPOSE: ${strategy.reason}\x1b[0m`);
                console.log(`  \x1b[90m  Strategy: ${strategy.type}\x1b[0m`);
                
                conversationHistory.push({
                  role: 'user',
                  content: `[DECOMPOSE] After ${MAX_IMPROVE_ITERATIONS} failed fix attempts, changing strategy.\n\n${strategy.instruction}`,
                });
              }
            }
          } else if (validation && validation.passed) {
            if (improvementAttempts[filePath] > 0) {
              console.log(tui.improvementFixed(filePath, improvementAttempts[filePath]));
              improvementAttempts[filePath] = 0;
            }
          }
        }

        // ── IMPROVEMENT LOOP: auto-validate bash/run commands that fail ──
        if ((toolName === 'bash' || toolName === 'run' || toolName === 'create_and_run') && result.error) {
          if (!improvementAttempts['__bash']) improvementAttempts['__bash'] = 0;
          improvementAttempts['__bash']++;

          if (improvementAttempts['__bash'] <= 2) {
            // Fix #5: Cap error output to 800 chars (~200 tokens) to prevent
            // context accumulation. The full output is already in the tool result.
            const cappedError = (result.result || '').slice(0, 800);
            conversationHistory.push({
              role: 'user',
              content: `[AUTO-FIX] The command FAILED (attempt ${improvementAttempts['__bash']}/2). Do NOT claim success. The error was:\n${cappedError}\n\nRead the error, identify the bug, and fix it.`,
            });
          } else {
            // DECOMPOSE: bash keeps failing, break the problem apart
            if (!improvementAttempts['__decompose:bash']) improvementAttempts['__decompose:bash'] = 0;
            improvementAttempts['__decompose:bash']++;

            if (improvementAttempts['__decompose:bash'] >= 2 && escalationEngine && escalationEngine.canEscalate()) {
              // Bash decompose failed twice — escalate
              console.log(`  \x1b[35m⬆ ESCALATING to ${escalationEngine.provider} (${escalationEngine.model}) — command keeps failing\x1b[0m`);
              improvementAttempts['__bash'] = 0;
              improvementAttempts['__decompose:bash'] = 0;

              const escalationMessages = [
                ...conversationHistory.slice(-8),
                { role: 'user', content: `The command keeps failing. Fix the underlying issue. Error: ${(result.result || '').slice(0, 1500)}` },
              ];
              
              const escalatedResponse = await escalationEngine.escalate(escalationMessages, ALL_TOOLS);
              if (escalatedResponse && !escalatedResponse.error) {
                if (escalatedResponse.tool_calls) {
                  conversationHistory.push(escalatedResponse);
                  for (const tc of escalatedResponse.tool_calls) {
                    const eName = tc.function.name;
                    let eArgs;
                    try { eArgs = JSON.parse(tc.function.arguments); } catch { eArgs = {}; }
                    process.stdout.write(`  \x1b[35m⬆\x1b[0m `);
                    process.stdout.write(tui.toolStart(eName));
                    const eResult = await executeTool(eName, eArgs);
                    if (eResult.error) {
                      console.log(tui.toolError(eResult.error));
                    } else {
                      console.log(tui.toolSuccess('', 0));
                    }
                    conversationHistory.push({ role: 'tool', tool_call_id: tc.id, content: eResult.result || eResult.error || '' });
                  }
                } else if (escalatedResponse.content) {
                  conversationHistory.push({ role: 'assistant', content: escalatedResponse.content });
                  process.stdout.write(tui.renderMarkdown(escalatedResponse.content));
                }
              } else {
                console.log(`  \x1b[31m✗ Escalation failed\x1b[0m`);
                conversationHistory.push({
                  role: 'user',
                  content: `[ESCALATION FAILED] Move on. Explain what you tried and what's still broken.`,
                });
              }
            } else {
              // First bash decompose — try local model with new strategy
              improvementAttempts['__bash'] = 0;
              // MarrowScript Rank 5: try LLM-based decompose strategy first
              let strategy;
              try {
                const { decomposeTask } = require('./features_adapter');
                if (decomposeTask) {
                  const bashErrors = [(result.result || '').slice(0, 300)].join('\n');
                  const decomposeResult = await decomposeTask(userMessage, bashErrors, toolArgs.command || '');
                  if (decomposeResult) strategy = { type: decomposeResult.strategy, reason: decomposeResult.reason, instruction: decomposeResult.instruction };
                }
              } catch {}
              if (!strategy) {
                const { pickDecomposeStrategy } = require('./governor');
                const errors = [(result.result || '').slice(0, 300)];
                strategy = pickDecomposeStrategy('', errors, toolArgs.command || '');
              }
              console.log(`  \x1b[33m◇ DECOMPOSE: Command keeps failing. Changing approach.\x1b[0m`);
              conversationHistory.push({
                role: 'user',
                content: `[DECOMPOSE] The command has failed 3 times. STOP retrying the same approach.\n\n${strategy.instruction}`,
              });
            }
          }
        } else if ((toolName === 'bash' || toolName === 'run') && !result.error) {
          improvementAttempts['__bash'] = 0;
        }

        // ── GOVERNOR: Record tool success/failure for Bayesian learning ──
        if (!result.error) {
          toolScorer.recordSuccess(toolName, currentTaskType, toolMs);
        } else {
          toolScorer.recordFailure(toolName, currentTaskType, result.error || 'unknown');
        }

        // ── EARLY-STOP: Detect patch spiral (model stuck on corrupted file) ──
        if (toolName === 'patch' || toolName === 'read_and_patch') {
          const patchSuccess = !result.error;
          const patchFile = toolArgs.path;
          const stopSignal = earlyStop.recordPatchResult(patchFile, patchSuccess, toolArgs.old_str, toolArgs.new_str);
          if (stopSignal) {
            console.log(`  \x1b[33m⚡ ${stopSignal.message}\x1b[0m`);
            conversationHistory.push({ role: 'user', content: stopSignal.injection });
            // Don't continue with normal flow — force model to rewrite
            break;
          }
        }

        // ── EARLY-STOP: Detect read loop (model endlessly reading without producing output) ──
        {
          const hasWrittenAnything = _editedFilesThisTurn.length > 0;
          const readLoopSignal = earlyStop.recordReadTool(toolName, hasWrittenAnything);
          if (readLoopSignal) {
            console.log(`  \x1b[33m⚡ ${readLoopSignal.message}\x1b[0m`);
            if (_fullscreenRef) _fullscreenRef.addTool('warning', 'warn', 'read loop — nudging toward output');
            conversationHistory.push({ role: 'user', content: readLoopSignal.injection });
            // For the hard stop (8 reads), break the loop to force a response
            if (readLoopSignal.reason === 'read_loop') break;
            // For the soft nudge (5 reads), let the model continue with the nudge injected
          }
        }

        // ── PLUGINS: Fire post_tool hooks ──
        if (pluginLoader && pluginLoader.hooks.length > 0) {
          for (const hook of pluginLoader.hooks) {
            if (hook.event === 'post_tool' && hook.handler) {
              if (hook.filter.length === 0 || hook.filter.includes(toolName)) {
                try { await hook.handler({ tool: toolName, args: toolArgs, result, ms: toolMs }); } catch {}
              }
            }
          }
        }
      }

      // Poisoned-history fix: if EVERY tool call in this turn produced a
      // validation error, revert history and inject a single correction note.
      // Without this, the model sees its own malformed tool calls + error
      // results in context and biases sampling toward more malformed output.
      if (__validationErrors.length > 0 && __validationErrors.length === message.tool_calls.length) {
        conversationHistory.length = __preTurnHistoryLen;
        conversationHistory.push({
          role: 'user',
          content: '[SYSTEM] Your previous response contained ONLY invalid tool-call arguments:\n' +
                   __validationErrors.map(e => '  - ' + e).join('\n') +
                   '\n\nRe-read the tool schemas and try again with valid arguments.',
        });
        if (_fullscreenRef) _fullscreenRef.addTool('warning', 'warn', 'all tool calls invalid — retrying with clean history');
        else console.log(chalk.yellow('  ⚠ All tool calls invalidated — retrying with clean history'));
      }

      // Continue the loop — model may want to call more tools or fix errors
      continue;
    }

    // No tool calls — model is responding with text
    // Counter guard: if this is a coding/editing task and no tools were called,
    // the model may be prematurely answering instead of acting
    if (toolCallsThisTurn === 0 && (currentTaskType === 'coding' || currentTaskType === 'editing' || currentTaskType === 'backend')) {
      if (message.content && !message.content.includes('?') && message.content.length < 200) {
        // Model gave a short non-question response without using tools — push it to act
        conversationHistory.push({ role: 'assistant', content: message.content });
        conversationHistory.push({ role: 'user', content: '[SYSTEM] You responded without using any tools. This task requires file operations. Please use the appropriate tools (read_file, write_file, patch, etc.) to complete the task. Do not just describe what you would do — actually do it.' });
        continue;
      }
    }

    // Greeting guard: detect when model outputs a greeting after tool failures (lost context)
    if (toolCallsThisTurn > 0 && message.content) {
      const greetingSignal = earlyStop.checkGreeting(message.content, toolCallsThisTurn > 0);
      if (greetingSignal && conversationHistory.some(m => m.role === 'user' && !m.content.startsWith('['))) {
        conversationHistory.push({ role: 'assistant', content: message.content });
        conversationHistory.push({ role: 'user', content: greetingSignal.injection });
        continue;
      }
    }

    // Post-decompose give-up detection: if model responds with vague text after failures, notify user
    if (toolCallsThisTurn > 0 && message.content) {
      const lc = message.content.toLowerCase();
      const gaveUp = lc.includes('output is truncated') || lc.includes('let me try') || lc.includes('let me run') || (lc.length < 100 && !lc.includes('?') && toolCallsThisTurn > 3);
      const hadDecompose = conversationHistory.some(m => m.content && m.content.includes('[DECOMPOSE]'));
      if (gaveUp && hadDecompose && escalationEngine && escalationEngine.canEscalate()) {
        // Model is stuck after decompose — offer escalation
        if (_fullscreenRef) {
          _fullscreenRef.addTool('escalation', 'err', 'Model stuck after decompose. Attempting escalation...');
        }
        conversationHistory.push({ role: 'assistant', content: message.content });
        conversationHistory.push({ role: 'user', content: '[SYSTEM] You appear stuck. The decompose strategy did not work. Take a completely different approach or clearly explain what is blocking you and what you need from the user to proceed.' });
        continue;
      }
    }

    // Stream the final response for better UX
    if (message.content) {
      // Contract done-guard: if a contract is active and the model claims
      // completion while assertions are still pending/failed, inject a
      // [CONTRACT-GUARD] system message and continue the loop instead of
      // pushing the wrap-up text. See src/session/contract_guard.js.
      try {
        const { checkDoneGuard } = require('../src/session/contract_guard');
        const guard = checkDoneGuard(message.content, process.cwd());
        if (guard) {
          conversationHistory.push({ role: 'assistant', content: message.content });
          conversationHistory.push({ role: 'user', content: guard.injection });
          if (_fullscreenRef) _fullscreenRef.addTool('contract', 'warn', `${guard.blockers.length} blockers`);
          else console.log(`  \x1b[33m⚠ contract guard: ${guard.blockers.length} unresolved assertion${guard.blockers.length === 1 ? '' : 's'}\x1b[0m`);
          continue;
        }
      } catch {}

      conversationHistory.push({ role: 'assistant', content: message.content });

      // Reviewer agent (Feature #18): async critique of the response when files
      // were edited this turn. Non-blocking — fires after history push, injects
      // a note only if a real issue is found. Disable with SMALLCODE_REVIEWER=false.
      if (_editedFilesThisTurn.length > 0 && message.content.length > 50) {
        try {
          const { reviewResponse, formatReviewerInjection, getReviewerConfig } = require('../src/model/reviewer');
          if (getReviewerConfig(config).enabled) {
            _reviewerPromise = reviewResponse(userMessage, message.content, _editedFilesThisTurn, config)
              .then(reviewResult => {
                const injection = formatReviewerInjection(reviewResult);
                if (injection) {
                  conversationHistory.push({ role: 'user', content: injection });
                  if (_fullscreenRef) _fullscreenRef.addTool('reviewer', 'err', reviewResult.issues[0]?.slice(0, 80) || 'issues found');
                  else console.log(`  \x1b[33m⚠ reviewer: ${reviewResult.issues[0]?.slice(0, 100) || 'issues found'}\x1b[0m`);
                }
              })
              .catch(() => {});
          }
        } catch {}
      }

      // Plan extraction from a tool-less response (model planned without tools)
      try {
        if (_planTracker && _planTracker.needsPlan()) {
          // MarrowScript Feature #3: async LLM extractor with regex fallback
          if (await _planTracker.ingestResponseAsync(message.content)) {
            if (_fullscreenRef) _fullscreenRef.addTool('plan', 'ok', `${_planTracker.plan.length} steps`);
            // Remove the one-shot instruction from history (same as tool-call path)
            if (_planInstructionIdx >= 0 && _planInstructionIdx < conversationHistory.length) {
              const msg = conversationHistory[_planInstructionIdx];
              if (msg && msg.role === 'system' && typeof msg.content === 'string' &&
                  msg.content.includes('numbered plan')) {
                conversationHistory.splice(_planInstructionIdx, 1);
              }
              _planInstructionIdx = -1;
            }

            // Feature 4 + 3: path validation + dependency graph (same as tool-call path)
            try {
              const { validatePlanPaths, buildDependencyGraph, toParallelBatches, formatBatchSummary } = require('../src/session/dependency_graph');
              const { missing } = validatePlanPaths(_planTracker.plan, process.cwd());
              if (missing.length > 0) {
                const warnMsg = `[PATH-VALIDATION] Plan references files that don't exist on disk: ${missing.join(', ')}. ` +
                  `Use find_files or bash to locate the correct paths before proceeding.`;
                conversationHistory.push({ role: 'system', content: warnMsg });
                if (_fullscreenRef) _fullscreenRef.addTool('warning', 'warn', `missing paths: ${missing.join(', ')}`);
              }
              const graph = buildDependencyGraph(_planTracker.plan, process.cwd());
              const batches = toParallelBatches(graph, _planTracker.plan.length);
              _planTracker._executionBatches = batches;
              if (_fullscreenRef && batches.length > 0) {
                _fullscreenRef.addTool('plan', 'ok', formatBatchSummary(batches));
              }
            } catch {}
          }
        }
      } catch {}

      // Detect "step N done" markers so the plan tracker advances.
      // Matches: "step 1 done", "step 1: done", "Step 1. complete", "step1 finished".
      try {
        if (_planTracker && _planTracker.plan) {
          const stepDone = (message.content || '').match(/\bstep\s*(\d{1,2})[\s:.\-]+(?:done|complete|completed|finished|✓)\b/gi);
          if (stepDone) {
            for (const m of stepDone) {
              const n = parseInt(m.match(/\d+/)[0], 10);
              if (n >= 1 && n <= _planTracker.plan.length) {
                _planTracker.completeStep(n - 1);
              }
            }
          }
        }
      } catch {}
      // Render with markdown highlighting
      if (_fullscreenRef) {
        _fullscreenRef.addChat('assistant', message.content);
      } else {
        process.stdout.write(tui.renderMarkdown(message.content));
      }
    } else if (toolCallsThisTurn === 0 && (!message.tool_calls || message.tool_calls.length === 0)) {
      // No content AND no tool calls AND no tools were called this turn — try streaming
      const streamedContent = await streamFinalResponse(config, conversationHistory);
      if (streamedContent) {
        conversationHistory.push({ role: 'assistant', content: streamedContent });
      }
    }
    // If tools were called but model returned empty content, that's fine — task is done.
    break;
  }

  if (toolCallsThisTurn >= MAX_TOOL_CALLS) {
    console.log(chalk.yellow('\n  ⚠ Reached tool call limit'));
  }

  if (toolCallsThisTurn > 0) {
    console.log(tui.turnSummary(toolCallsThisTurn));

    // Auto git commit if files were changed and we're in a git repo
    if (config.git?.auto_commit === true || process.env.SMALLCODE_AUTO_COMMIT === 'true') {
      try {
        const { execSync, execFileSync } = require('child_process');
        const status = execSync('git status --porcelain', { encoding: 'utf-8', cwd: process.cwd(), timeout: 5000 });
        if (status.trim()) {
          // MarrowScript Feature #2: use compiled commit_message prompt instead of
          // simple string truncation. Falls back to truncation if prompt unavailable.
          const lastUser = [...conversationHistory].reverse().find(m => m.role === 'user' && !m.content.startsWith('['));
          const task = lastUser ? lastUser.content : 'auto-commit';
          let commitMsg;
          try {
            const { generateCommitMessage } = require('./features_adapter');
            commitMsg = await generateCommitMessage(task, _editedFilesThisTurn);
          } catch {
            commitMsg = `smallcode: ${task.slice(0, 50).replace(/[\n\r"'`$\\]/g, ' ').trim()}`;
          }
          execFileSync('git', ['add', '-A'], { cwd: process.cwd(), timeout: 5000 });
          execFileSync('git', ['commit', '-m', commitMsg], { encoding: 'utf-8', cwd: process.cwd(), timeout: 10000 });
          if (_fullscreenRef) {
            _fullscreenRef.addTool('git', 'ok', `committed: ${commitMsg.slice(0, 60)}`);
          } else {
            console.log(chalk.green(`  ✓ git commit: ${commitMsg.slice(0, 60)}`));
          }
        }
      } catch {
        // Not a git repo or commit failed — silently skip
      }
    }
  }

  // Stop trace recording for this turn — and convert the trace into a
  // searchable evidence memory so future tasks can learn from what worked
  // and what failed. Stored as type:'context' tag:'evidence' in the existing
  // memory MCP module so it doesn't hog the live system prompt.
  const finishedTrace = traceRecorder.stop();

  // Clean up planner injection (Feature #15) — remove the chain planner's
  // system message from history so it doesn't pollute future turns.
  if (_plannerInjected) {
    const idx = conversationHistory.findIndex(m =>
      m.role === 'system' && typeof m.content === 'string' &&
      m.content.includes('PRE-ANALYZED PLAN'));
    if (idx >= 0) conversationHistory.splice(idx, 1);
  }

  // Await reviewer result (Feature #18) — give it up to 5 extra seconds
  // before exiting so non-interactive runs can still receive critique injection.
  if (typeof _reviewerPromise !== 'undefined' && _reviewerPromise) {
    try {
      await Promise.race([
        _reviewerPromise,
        new Promise(r => setTimeout(r, 5000)),
      ]);
    } catch {}
  }
  try {
    if (finishedTrace) {
      const { recordEvidence } = require('../src/memory/evidence');
      recordEvidence(memoryStore, finishedTrace);
    }
  } catch {} // never fail the agent loop on evidence-storage errors

  // Commit (discard) the snapshot checkpoint — clean run, no rollback needed.
  // If a hard failure earlier in the loop wanted to roll back, it would have
  // called rollback() before reaching here; commit() is a no-op in that case.
  try {
    const { getSnapshotManager } = require('../src/session/snapshot');
    getSnapshotManager().commit();
  } catch {}
}

// ─── Validation for Improvement Loop ────────────────────────────────────────

// LSP client instance (lazy-initialized on first validation)
let _lspClient = null;
let _lspAttempted = false;

async function initLSP() {
  if (_lspAttempted) return _lspClient;
  _lspAttempted = true;
  try {
    const { LSPClient } = require('../src/lsp/client');
    const client = new LSPClient(process.cwd());
    const ok = await client.start();
    if (ok) {
      _lspClient = client;
      if (_fullscreenRef) _fullscreenRef.addTool('lsp', 'ok', `${client.serverInfo.language} language server connected`);
    }
  } catch {}
  return _lspClient;
}

// runValidation: delegate to the hardened version in model_client.js
// which uses execFileSync with arg arrays (no shell injection via filePath).
// The old inline version used shell-interpolated strings which allowed a
// model-controlled filePath like `foo.py"; rm -rf /; echo "` to execute.
function runValidation(filePath) {
  return _runValidationModule(filePath);
}

// Build a compact system prompt — only includes sections relevant to the task type.
// When SMALLCODE_CACHE_SPLIT=true (Feature #14), this returns ONLY the static portion
// (identity, OS, bootstrap, rules) so it's cache-friendly across turns. Dynamic content
// (memory, knowledge, plan, test runner) is moved into a [CONTEXT] block prepended to
// the latest user message via buildDynamicContext().
//
// When SMALLCODE_CACHE_SPLIT=false (default for backwards compat), everything is in
// the system prompt as before.
function buildCompactSystemPrompt(taskType, messages) {
  const cacheSplit = process.env.SMALLCODE_CACHE_SPLIT === 'true';
  const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const osHint = process.platform === 'win32' ? '\nUse "dir" not "ls", "type" not "cat". No bash-only commands.' : '';

  // Bootstrap detection (Feature 11): compact project summary at the top so
  // the model knows its runtime, build/test commands, and entry point without
  // burning tool calls on discovery.
  let bootstrapLine = '';
  try {
    if (_bootstrapDetector) {
      const raw = _bootstrapDetector.formatForPrompt();
      // Prefix as a workspace hint so the model treats it as tool context,
      // not as a project description to regurgitate when users ask questions.
      // Without this framing models answer "tell me about the project" from
      // the bootstrap summary instead of reading README.md.
      if (raw) bootstrapLine = raw.replace('\n\nProject:', '\n\nWorkspace context:');
    }
  } catch {}

  let prompt = `You are SmallCode, a coding agent. Working directory: ${process.cwd()}
OS: ${os}${osHint}${bootstrapLine}

Rules: Use patch for edits (not full rewrites). Prefer compound tools. Be concise. ACT immediately — do not ask for confirmation unless the task is genuinely ambiguous. If asked to read a file, read it. If asked to create something, create it. If asked about the project, read README.md or relevant files — do not answer from the workspace context line above.

CRITICAL — large file rule: write_file calls are limited to 60 lines / ~8KB. llama.cpp's JSON parser crashes on larger tool calls. For any file over 60 lines: (1) write_file with just the skeleton (imports + empty stubs), then (2) use multiple patch calls to fill in each function/section. Never put more than 60 lines in a single write_file content field.`;

  // Only add tool-use instructions for tasks that need tools
  if (taskType !== 'explanation') {
    prompt += `\nUse graph_search/explain_symbol for "how does X work" questions. Use list_projects for workspace overview.`;
  }

  // Only add BoneScript for backend tasks
  if (taskType === 'backend') {
    prompt += `\n\nFor Node.js backends: write a .bone file → bone_check → bone_compile. Don't hand-write routes.`;
  }

  if (cacheSplit) {
    // Dynamic context goes into a separate [CONTEXT] user message — see
    // buildDynamicContext(). Plan + plugins stay here (system role = authoritative).
    prompt += getPluginPrompts() + getActivePlanContext() + getTestRunnerContext();
    return prompt;
  }

  // Legacy behavior: everything in the system prompt
  prompt += getMemoryContext(messages) + getSkillContext(messages) + getPluginPrompts() + getKnowledgeContext(messages) + getActivePlanContext() + getTestRunnerContext();

  return prompt;
}

// Build the dynamic context block that goes into a [CONTEXT] user message
// when SMALLCODE_CACHE_SPLIT=true. Returns '' when there's no dynamic content
// or when cache-split is disabled.
function buildDynamicContext(messages) {
  if (process.env.SMALLCODE_CACHE_SPLIT !== 'true') return '';
  const parts = [
    // Memory + knowledge are query-dependent → move to user message (dynamic)
    getMemoryContext(messages),
    getSkillContext(messages),
    getKnowledgeContext(messages),
    // Note: getPluginPrompts() stays in the system prompt — plugin instructions
    //   are authoritative and should come from the system role.
    // Note: getActivePlanContext() stays in the system prompt — the model needs
    //   to trust plan step instructions; user-role is ignored for directives.
    // Note: getTestRunnerContext() stays in the system prompt — it's stable and
    //   benefits from caching alongside the static base.
  ].filter(p => p && p.length > 0);
  if (parts.length === 0) return '';
  // Strip ANSI from the dynamic block — same reason we strip from messages:
  // memory/knowledge entries can contain ANSI color codes from prior tool output.
  const raw = `<sc:context>\n${parts.join('')}\n</sc:context>\n\n`;
  return raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// Test runner context (Feature 10): inject the detected test command once
// so the model knows how to run tests without 3 discovery tool calls.
function getTestRunnerContext() {
  try {
    if (_testRunnerDetector) return _testRunnerDetector.formatForPrompt();
  } catch {}
  return '';
}

// Active plan injection (Feature 8). Returns '' when no plan is active.
function getActivePlanContext() {
  try {
    if (_planTracker && _planTracker.plan) {
      return _planTracker.formatForPrompt();
    }
  } catch {}
  return '';
}

// Auto-load knowledge notes (algorithm cheat sheets, syntax reminders, etc.)
// from the project's knowledge/ directory based on keyword overlap with the
// last user message. Disabled if the directory doesn't exist.
function getKnowledgeContext(messages) {
  try {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser || typeof lastUser.content !== 'string') return '';
    const loader = _knowledgeLoader;
    if (!loader) return '';
    const maxTokens = Math.min(1500, Math.floor(((config?.context?.detected_window || 32768) * 0.04)));
    return loader.formatForPrompt(lastUser.content, { maxTokens });
  } catch {
    return '';
  }
}

// Auto-load relevant memory for the current task (injected into system prompt)
// Fix #15: Only inject memory objects with score >= 2 (at least 2 word matches)
// to avoid burning tokens on low-relevance hits.
function getMemoryContext(messages) {
  try {
    // Get the last user message to find relevant memory
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser || !memoryStore.loadForTask) return '';

    // loadForTask returns scored objects; only include those with meaningful relevance
    const maxTokens = Math.min(800, Math.floor(((config?.context?.detected_window || 32768) * 0.03)));
    const objects = memoryStore.loadForTask(lastUser.content, maxTokens);
    // Handle both old format (array) and new format ({objects, tokens_used})
    const items = Array.isArray(objects) ? objects : (objects?.objects || []);
    if (items.length === 0) return '';

    // Cap total injection to ~800 tokens (3200 chars)
    let output = '\n\nRelevant project memory:\n';
    let chars = output.length;
    const maxChars = 3200;
    for (const o of items) {
      const entry = `[${o.type}] ${o.title}: ${o.content}\n`;
      if (chars + entry.length > maxChars) break;
      output += entry;
      chars += entry.length;
    }
    return output;
  } catch {
    return '';
  }
}

// Auto-load relevant skills based on the user's message
// Fix #18: Cap skill injection to ~1000 tokens (4000 chars). Multiple matching
// skills can each be a full .md file, quickly blowing up the system prompt.
function getSkillContext(messages) {
  if (!skillManager) return '';
  try {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return '';
    const skills = skillManager.getAutoSkills(lastUser.content);
    if (skills.length === 0) return '';
    const formatted = skillManager.formatForPrompt(skills);
    // Hard cap: truncate if too long
    return formatted.length > 4000
      ? formatted.slice(0, 4000) + '\n... (skills truncated to fit context)'
      : formatted;
  } catch {
    return '';
  }
}

// Get plugin prompt injections for the current task type
// Fix #17: Cap plugin injection to ~500 tokens (2000 chars).
function getPluginPrompts() {
  if (!pluginLoader) return '';
  try {
    const injection = pluginLoader.getPromptInjections(currentTaskType);
    if (!injection) return '';
    // Hard cap: a single misconfigured plugin with 10k content shouldn't
    // blow up the system prompt.
    const capped = injection.length > 2000
      ? injection.slice(0, 2000) + '\n... (plugin prompts truncated)'
      : injection;
    return '\n\n' + capped;
  } catch {
    return '';
  }
}

// Make a chat completion request (non-streaming for tool use, streaming for final response)
async function chatCompletion(config, messages) {
  const baseUrl = config.model.baseUrl;
  const systemMsg = {
    role: 'system',
    content: buildCompactSystemPrompt(currentTaskType, messages),
  };

  try {
    // Strip ANSI escape codes from all message content before sending to model.
    // Thinking models (Qwen3, etc.) will reproduce ANSI codes they see in context,
    // causing corrupted bash commands like "find ... -\x1b[38;2mtype f".
    function stripAnsiFromMsg(msg) {
      if (!msg || typeof msg.content !== 'string') return msg;
      return { ...msg, content: msg.content.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '') };
    }
    const processedMessages = messages.map(stripAnsiFromMsg);

    // Cache-split (Feature #14): when SMALLCODE_CACHE_SPLIT=true, dynamic
    // context (memory, knowledge) is moved out of the system prompt and into
    // a [CONTEXT] block prepended to the latest user message. This keeps the
    // system prompt stable across turns so remote APIs with prefix caching
    // (Anthropic, OpenAI) get cache hits on the static portion.
    const dynamicCtx = buildDynamicContext(messages);
    if (dynamicCtx) {
      const lastIdx = processedMessages.reduce((last, m, i) => m.role === 'user' ? i : last, -1);
      if (lastIdx >= 0) {
        const lastMsg = processedMessages[lastIdx];
        if (typeof lastMsg.content === 'string') {
          processedMessages[lastIdx] = {
            ...lastMsg,
            content: dynamicCtx + lastMsg.content,
          };
        }
        // If last user message is multimodal (image array), prepend as first text element
        else if (Array.isArray(lastMsg.content)) {
          const firstText = lastMsg.content.find(c => c.type === 'text');
          if (firstText) {
            processedMessages[lastIdx] = {
              ...lastMsg,
              content: [
                { type: 'text', text: dynamicCtx + firstText.text },
                ...lastMsg.content.filter(c => c !== firstText),
              ],
            };
          }
        }
      }
    }

    // Transform messages with images into multimodal format
    // OPTIMIZATION: Only re-extract images from the LAST user message (the new one).
    // Older messages that had images already had their content consumed; re-reading
    // the image from disk on every call is both wasteful (disk I/O) and causes
    // context overflow (a 1MB PNG = ~330k base64 tokens sent on EVERY API call).
    const { extractImages, formatImagesForAPI, modelSupportsVision } = require('../src/session/images');
    const lastUserIdx = processedMessages.length > 0
      ? processedMessages.reduce((last, m, i) => m.role === 'user' ? i : last, -1)
      : -1;
    const processedWithImages = processedMessages.map((msg, idx) => {
      if (msg.role !== 'user' || typeof msg.content !== 'string') return msg;
      // Only extract images from the most recent user message
      if (idx !== lastUserIdx) return msg;
      const images = extractImages(msg.content, process.cwd());
      if (images.length === 0 || !modelSupportsVision(config.model.name)) return msg;
      return {
        ...msg,
        content: [
          { type: 'text', text: msg.content },
          ...formatImagesForAPI(images),
        ],
      };
    });

    const _tools = getAllTools(config, currentToolCategory);
    const body = {
      model: config.model.name,
      messages: [systemMsg, ...processedWithImages],
      temperature: 0.1,
      max_tokens: parseInt(process.env.SMALLCODE_MAX_OUTPUT_TOKENS) || 8192,
    };
    // Only include tools when there are tools to send — some endpoints (OpenWebUI)
    // error on an empty tools array rather than treating it as "no tools".
    if (_tools && _tools.length > 0) {
      body.tools = _tools;
    }

    // Multi-model chaining (Feature #15): override model name with executor
    // if chain config is active. No-op when SMALLCODE_CHAIN is not set.
    try {
      const { getExecutorModel } = require('../src/model/chain');
      body.model = getExecutorModel('', config); // task already classified at loop start
    } catch {}

    // MarrowScript Rank 8: adaptive model routing
    // Override body.model when failure rate warrants a stronger model.
    try {
      const { getAdaptiveRouter } = require('../src/model/adaptive_router');
      const router = getAdaptiveRouter();
      const selected = router.selectModel(config);
      if (selected.model && selected.model !== body.model) {
        if (_fullscreenRef) _fullscreenRef.addTool('adaptive', 'ok', `→ ${selected.model} (high failure rate)`);
        body.model = selected.model;
      }
    } catch {}

    // Apply thinking budget for reasoning models (Qwen3, DeepSeek R1, Claude with
    // thinking, GPT-5 reasoning). Without this, a small reasoning model can spend
    // 8000 tokens "thinking" about a trivial rename. Defaults to 2000 tokens;
    // override with SMALLCODE_THINKING_BUDGET. Set SMALLCODE_THINKING_DISABLE=true
    // to turn it off entirely.
    try {
      const { applyThinkingBudget } = require('../src/model/thinking_budget');
      applyThinkingBudget(body, { baseUrl });
    } catch {} // optional — fall through if module unavailable

    // Adaptive retry temperature (Feature 12): nudge temperature per attempt.
    // Only count attempts for the CURRENT file being validated (not stale entries
    // from previous files that have already been fixed or reset).
    try {
      const { applyAdaptiveTemperature } = require('../src/model/adaptive_temp');
      // Sum only numeric values (filePath keys) that are currently non-zero.
      // Exclude __history:*, __decompose:* meta-keys and already-resolved (0) entries.
      const currentAttempt = Object.entries(improvementAttempts)
        .filter(([k, v]) => !k.startsWith('__') && typeof v === 'number' && v > 0)
        .reduce((acc, [, v]) => acc + v, 0);
      if (currentAttempt > 0) {
        applyAdaptiveTemperature(body, currentAttempt, { isRepair: true });
      }
    } catch {}

    // Build headers — include Authorization if an API key is available
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || config.model.apiKey;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    // OpenRouter requires HTTP-Referer and X-Title headers
    if (baseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://github.com/Doorman11991/smallcode';
      headers['X-Title'] = 'SmallCode';
    }

    // Timeout: abort if model doesn't respond within configured limit.
    // Default 300s (5 min) — enough for slow hardware (RK3588, CPU inference).
    // Override via SMALLCODE_MODEL_TIMEOUT env var (seconds) or smallcode.toml model.timeout.
    const timeoutSecs = parseInt(process.env.SMALLCODE_MODEL_TIMEOUT)
      || config.model?.timeout
      || 300;
    const timeoutMs = timeoutSecs * 1000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Spinner: show rotating ASCII while waiting for the model to respond.
    // Gives the user clear visual feedback that the process is alive, not hung.
    // Clears when the response arrives or on error.
    let _spinnerInterval = null;
    let _spinnerElapsed = 0;
    const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    if (!_fullscreenRef && process.stdout.isTTY) {
      let _spinFrame = 0;
      _spinnerInterval = setInterval(() => {
        _spinnerElapsed += 100;
        const secs = (_spinnerElapsed / 1000).toFixed(1);
        process.stdout.write(`\r  ${SPINNER_FRAMES[_spinFrame % SPINNER_FRAMES.length]} Waiting for model... ${secs}s \r`);
        _spinFrame++;
      }, 100);
    } else if (_fullscreenRef) {
      // In fullscreen TUI, pulse the status bar instead
      let _spinFrame = 0;
      _spinnerInterval = setInterval(() => {
        _spinnerElapsed += 200;
        _fullscreenRef.setStatus?.(`${SPINNER_FRAMES[_spinFrame % SPINNER_FRAMES.length]} thinking ${(_spinnerElapsed / 1000).toFixed(0)}s`);
        _spinFrame++;
      }, 200);
    }
    const _stopSpinner = () => {
      if (_spinnerInterval) {
        clearInterval(_spinnerInterval);
        _spinnerInterval = null;
        if (!_fullscreenRef && process.stdout.isTTY) {
          process.stdout.write('\r' + ' '.repeat(50) + '\r'); // clear spinner line
        } else if (_fullscreenRef) {
          _fullscreenRef.setStatus?.('');
        }
      }
    };

    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeout);
      _stopSpinner();
      // Distinguish timeout from unreachable endpoint — show both in TUI and console
      if (fetchErr.name === 'AbortError' || fetchErr.message?.includes('abort')) {
        const msg = `Model timed out after ${timeoutSecs}s. The model is still processing or the endpoint is unresponsive.\n  Tip: increase timeout with SMALLCODE_MODEL_TIMEOUT=600 in your .env`;
        console.log(`  \x1b[33m⏱ ${msg}\x1b[0m`);
        if (_fullscreenRef) _fullscreenRef.addTool('timeout', 'err', `no response after ${timeoutSecs}s`);
      } else {
        // Surface the actual LM Studio / endpoint error in the TUI so the user
        // can see what went wrong without digging through logs.
        const errMsg = fetchErr.message || 'Connection failed';
        const hint = errMsg.includes('ECONNREFUSED') ? ' — is LM Studio running?' :
                     errMsg.includes('ENOTFOUND')    ? ' — check SMALLCODE_BASE_URL' :
                     errMsg.includes('ECONNRESET')   ? ' — LM Studio may have crashed or restarted' :
                     '';
        console.log(`  \x1b[31m✗ Endpoint error: ${errMsg}${hint}\x1b[0m`);
        if (_fullscreenRef) _fullscreenRef.addTool('error', 'err', `${errMsg.slice(0, 80)}${hint}`);
      }
      return null;
    }
    clearTimeout(timeout);
    _stopSpinner();

    if (!response.ok) {
      const err = await response.text();
      // Retry once on any non-2xx response. 5xx from llama-server is often a
      // one-off tool-call JSON parse failure that recovers on the next sampling
      // pass; 4xx covers rate limit / model reload.
      if (response.status >= 400) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const retry = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });
          if (retry.ok) return await retry.json();
        } catch {}
      }
      const errDetail = err.slice(0, 200);
      console.log(`  \x1b[31m✗ API error ${response.status}: ${errDetail}\x1b[0m`);
      if (_fullscreenRef) _fullscreenRef.addTool('error', 'err', `HTTP ${response.status}: ${errDetail.slice(0, 80)}`);
      // MarrowScript Rank 8: record failure for adaptive routing
      try { const { getAdaptiveRouter } = require('../src/model/adaptive_router'); getAdaptiveRouter().recordCall(body.model || config.model.name, false); } catch {}
      return null;
    }

    const data = await response.json();

    // Track token usage
    if (tokenTracker && data?.usage) {
      tokenTracker.record(data, config.model.name);
    }
    if (data?.usage) {
      tokenMonitor.recordCall(data.usage.prompt_tokens, data.usage.completion_tokens);
      traceRecorder.recordTokens(data.usage.prompt_tokens, data.usage.completion_tokens);
      // Feature 3: charge token budget
      if (chargeBudget) {
        try { chargeBudget('run_turn', { tokens: (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0) }); } catch {}
      }
    }

    // MarrowScript Rank 8: record successful call for adaptive routing
    try {
      const { getAdaptiveRouter } = require('../src/model/adaptive_router');
      getAdaptiveRouter().recordCall(body.model || config.model.name, true);
    } catch {}

    // Auto-save session periodically
    if (sessionStore) {
      sessionStore.save(conversationHistory, {
        tokens: tokenTracker ? tokenTracker.stats() : undefined,
      });
      sessionStore.autoTitle(conversationHistory);
    }

    return data;
  } catch (err) {
    console.log(`  \x1b[31m✗ ${err.message}\x1b[0m`);
    return null;
  }
}

// Stream a final text response (no tools, just text output)
async function streamFinalResponse(config, messages) {
  const baseUrl = config.model.baseUrl;
  const systemMsg = {
    role: 'system',
    content: `You are SmallCode, a coding assistant. Summarize what you just did in 1-2 sentences. Be concise.`
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || config.model.apiKey;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (baseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://github.com/Doorman11991/smallcode';
      headers['X-Title'] = 'SmallCode';
    }

    // Fix #3: Only include messages that form valid pairs. Strip tool_call
    // assistant messages that don't have a following tool result (which causes
    // 400 errors on strict providers). Also strip tool messages whose assistant
    // owner was already dropped by the slice.
    const recent = messages.slice(-8);
    const safeMessages = [];
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      if (m.tool_calls) {
        // Only include if ALL tool_call_ids have a matching tool result after it
        const ids = m.tool_calls.map(tc => tc.id);
        const hasAll = ids.every(id => recent.slice(i + 1).some(r => r.role === 'tool' && r.tool_call_id === id));
        if (hasAll) safeMessages.push(m);
        // else skip it
      } else if (m.role === 'tool') {
        // Only include if there's a preceding assistant with this tool_call_id
        const hasOwner = safeMessages.some(s => s.tool_calls && s.tool_calls.some(tc => tc.id === m.tool_call_id));
        if (hasOwner) safeMessages.push(m);
        // else skip orphan
      } else {
        safeMessages.push(m);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout for summary

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model.name,
        messages: [systemMsg, ...safeMessages.slice(-6)],
        stream: true,
        temperature: 0.1,
        max_tokens: 256,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    // Start streaming display
    if (_fullscreenRef) _fullscreenRef.setStreaming(true);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          if (_fullscreenRef) { _fullscreenRef.endStream(); _fullscreenRef.setStreaming(false); }
          else console.log('');
          return fullContent;
        }
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            if (_fullscreenRef) {
              _fullscreenRef.streamToken(delta.content);
            } else {
              process.stdout.write(delta.content);
            }
            fullContent += delta.content;

            // Early-stop: check for repetition loops during streaming
            const stopSignal = earlyStop.checkRepetition(fullContent);
            if (stopSignal) {
              if (_fullscreenRef) { _fullscreenRef.endStream(); _fullscreenRef.setStreaming(false); }
              else console.log(`\n  \x1b[33m⚡ ${stopSignal.message}\x1b[0m`);
              return fullContent;
            }
          }
        } catch {}
      }
    }
    if (_fullscreenRef) { _fullscreenRef.endStream(); _fullscreenRef.setStreaming(false); }
    else console.log('');
    return fullContent;
  } catch {
    return null;
  }
}

// Streaming version for when no tools are needed (direct responses)
async function sendToModel(message, config) {
  const baseUrl = config.model.baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';
  const systemPrompt = `You are SmallCode, a coding assistant. You help users by reading, editing, and creating code files.
Rules:
- Read files before editing them.
- Use search-and-replace for edits. Never rewrite entire files.
- Keep responses concise and focused.
- If a task is complex, break it into steps.`;

  // OpenAI-compatible (LM Studio, vLLM, etc.)
  if (config.model.provider === 'openai' || baseUrl.includes('/v1')) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || config.model.apiKey;
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      if (baseUrl.includes('openrouter.ai')) {
        headers['HTTP-Referer'] = 'https://github.com/Doorman11991/smallcode';
        headers['X-Title'] = 'SmallCode';
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model.name,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          stream: true,
          temperature: 0.1,
          max_tokens: 4096,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.log(`  ✗ LM Studio error: ${response.status} ${err.slice(0, 200)}`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') { console.log(''); return; }
          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              process.stdout.write(delta.content);
            }
          } catch {}
        }
      }
      console.log('');
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}`);
    }
    return;
  }

  // Ollama native endpoint
  try {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model.name,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        stream: true,
      }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message && chunk.message.content) {
            process.stdout.write(chunk.message.content);
          }
          if (chunk.done) { console.log(''); return; }
        } catch {}
      }
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }
}

// ─── Non-Interactive Mode ────────────────────────────────────────────────────

async function runNonInteractive(config, prompt) {
  if (!prompt) {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    prompt = Buffer.concat(chunks).toString().trim();
  }

  if (!prompt) {
    console.error('No prompt provided.');
    process.exit(1);
  }

  await runAgentLoop(prompt, config);

  // Explicit cleanup so the process exits cleanly. The persistent shell holds
  // a child cmd.exe with open stdio pipes that would otherwise keep the
  // Node event loop alive even after the agent loop returns.
  try {
    const { resetShell } = require('../src/tools/shell_session');
    resetShell();
  } catch {}
  try {
    const { resetReadTracker } = require('../src/tools/read_tracker');
    resetReadTracker();
  } catch {}
  try {
    const { resetFileStateTracker } = require('../src/session/file_state');
    resetFileStateTracker();
  } catch {}
  try {
    const { resetDedup, resetIdempotentWriteSet } = require('../src/tools/dedup');
    resetDedup();
    resetIdempotentWriteSet();
  } catch {}
  try {
    const { resetSnapshotManager } = require('../src/session/snapshot');
    resetSnapshotManager();
  } catch {}
  try {
    const { resetTrustDecay } = require('../src/tools/trust_decay');
    resetTrustDecay();
  } catch {}
  killMCP();
  if (_lspClient) { try { _lspClient.stop(); } catch {} }
  // Force exit after a short tick to let any pending log writes flush.
  setTimeout(() => process.exit(0), 100).unref();
}

// ─── MCP Server Mode ─────────────────────────────────────────────────────────

function runMCP() {
  // Minimal MCP server implementation over stdio.
  // Tool calls are handled async — we buffer the response and write it
  // when the handler resolves. This fixes the bug where smallcode_agent
  // (which calls the async runAgentLoop) would return before completing.
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    try {
      const request = JSON.parse(line);
      const response = await handleMCPRequest(request);
      console.log(JSON.stringify(response));
    } catch (err) {
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      }));
    }
  });
}

async function handleMCPRequest(request) {
  const { id, method } = request;
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'smallcode', version: VERSION },
      }};
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [
        { name: 'smallcode_read_file', description: 'Read file contents', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } },
        { name: 'smallcode_search', description: 'Search code with regex', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
        { name: 'smallcode_patch', description: 'Edit file via search-and-replace', inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } },
        { name: 'smallcode_bash', description: 'Run shell command', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
        { name: 'smallcode_memory_load', description: 'Load relevant project memory for a task', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
        { name: 'smallcode_memory_remember', description: 'Save knowledge to project memory', inputSchema: { type: 'object', properties: { type: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['type', 'title', 'content'] } },
        { name: 'smallcode_agent', description: 'Send a prompt to SmallCode agent', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
      ]}};
    case 'tools/call':
      return await handleMCPToolCall(id, request.params);
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` }};
  }
}

async function handleMCPToolCall(id, params) {
  const { name, arguments: args } = params;
  const { safeResolvePath, escapeShellArg, sanitizeToolOutput } = require('../src/security/sanitize');
  const cwd = process.cwd();
  let result = '';

  switch (name) {
    case 'smallcode_read_file': {
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${safe.reason}` }], isError: true }};
      try { result = sanitizeToolOutput(fs.readFileSync(safe.fullPath, 'utf-8')); }
      catch (e) { return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }}; }
      break;
    }
    case 'smallcode_bash': {
      const { execSync } = require('child_process');
      const command = String(args.command || '');
      // Apply same blocked-command checks as the agent's bash tool
      if (/rm\s+-rf\s+\/[^.]/.test(command) || /format\s+c:/i.test(command)) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: destructive command blocked' }], isError: true }};
      }
      try {
        const output = execSync(command, { encoding: 'utf-8', timeout: 30000, cwd, maxBuffer: 1024 * 1024 });
        result = sanitizeToolOutput(output).slice(0, 4000);
      } catch (e) { result = sanitizeToolOutput((e.stdout || '') + (e.stderr || e.message || '')).slice(0, 2000); }
      break;
    }
    case 'smallcode_search': {
      const { execSync } = require('child_process');
      const pattern = String(args.pattern || '');
      const searchPath = args.path ? safeResolvePath(args.path, cwd) : { ok: true, fullPath: '.' };
      if (!searchPath.ok) { result = `Error: ${searchPath.reason}`; break; }
      try {
        const cmd = 'rg --line-number --max-count 10 ' + escapeShellArg(pattern) + ' ' + escapeShellArg(searchPath.fullPath || '.');
        result = sanitizeToolOutput(execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd })).slice(0, 3000);
      } catch { result = 'No matches'; }
      break;
    }
    case 'smallcode_patch': {
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) { result = `Error: ${safe.reason}`; break; }
      try {
        let content = fs.readFileSync(safe.fullPath, 'utf-8');
        if (!content.includes(args.old_str)) { result = 'Error: old_str not found'; break; }
        const count = content.split(args.old_str).length - 1;
        if (count > 1) { result = `Error: old_str matches ${count} locations`; break; }
        content = content.replace(args.old_str, args.new_str);
        fs.writeFileSync(safe.fullPath, content);
        result = `Patched ${args.path}`;
      } catch (e) { result = `Error: ${e.message}`; }
      break;
    }
    case 'smallcode_memory_load': {
      const objects = memoryStore.loadForTask(args.task || '', 2000);
      // Handle both array return (MemoryStore in memory.js) and {objects} return
      const items = Array.isArray(objects) ? objects : (objects?.objects || []);
      result = items.length > 0
        ? items.map(o => `[${o.type}] ${o.title}: ${o.content}`).join('\n\n')
        : 'No relevant memory found.';
      break;
    }
    case 'smallcode_memory_remember': {
      const obj = memoryStore.remember(args.type || 'context', args.title || '', args.content || '', { tags: args.tags || [] });
      result = `Remembered: [${obj.type}] ${obj.title} (${obj.id})`;
      break;
    }
    default:
      result = `Unknown tool: ${name}`;
  }

  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] }};
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  config = loadConfig();

  // Check model is configured
  if (!config.model.name) {
    console.error('\n  ✗ No model configured.');
    console.error('  Set SMALLCODE_MODEL in .env, or add [model] name = "..." to smallcode.toml');
    console.error('  See .env.example for setup instructions.\n');
    process.exit(1);
  }

  // Initialize escalation engine
  escalationEngine = new EscalationEngine(config.escalation || {});

  // Detect model profile (drives routing mode, tool format, context budget)
  const modelProfile = getProfile(config.model.name, config.context.detected_window);
  if (modelProfile.matched_key) {
    // Apply profile-detected context window if not already set
    if (!config.context.detected_window && modelProfile.context_length) {
      config.context.detected_window = modelProfile.context_length;
    }
  }

  // Initialize plugins and skills
  pluginLoader = new PluginLoader(process.cwd()).loadAll();
  skillManager = new SkillManager(process.cwd());

  // Initialize MCP client (connect to external MCP servers)
  let mcpClient = null;
  const mcpClientInstance = new MCPClient(process.cwd());
  if (mcpClientInstance.loadConfig() > 0) {
    mcpClient = mcpClientInstance;
    // Connect asynchronously — don't block boot
    mcpClient.connectAll().then(toolCount => {
      if (toolCount > 0 && _fullscreenRef) {
        _fullscreenRef.addTool('mcp-client', 'ok', `${toolCount} external tools from ${mcpClient.servers.size} servers`);
      }
    }).catch(() => {});
  }

  // Initialize session + token tracking
  sessionStore = new SessionStore(process.cwd());
  tokenTracker = new TokenTracker();

  // Resume or create session
  if (flags.resume) {
    const resumed = sessionStore.resume();
    if (resumed) {
      conversationHistory.push(...resumed.messages);
      // Clear improvement state from previous session — stale counters
      // cause false-positive patch spirals and decompose triggers.
      Object.keys(improvementAttempts).forEach(k => delete improvementAttempts[k]);
    }
  }
  if (!sessionStore.current) {
    sessionStore.create(config.model.name);
  }

  if (flags.mcp) {
    runMCP();
    return;
  }

  if (flags.init) {
    require('./init');
    return;
  }

  // Eval mode: run prompt evaluation suites
  if (flags.eval) {
    const { EvalRunner } = require('./eval_runner');
    const evalRunner = new EvalRunner(config);
    console.log(`\n  Running evaluation: ${flags.eval}\n`);
    const results = await evalRunner.run(flags.eval, { chatCompletionFn: chatCompletion });
    if (results.error) {
      console.log(`  \x1b[31m✗ ${results.error}\x1b[0m`);
    } else {
      console.log(EvalRunner.format(results));
      console.log('');
    }
    process.exit(results.error ? 1 : 0);
  }

  if (flags.acp) {
    const { ACPAdapter } = require('../src/adapters/acp');
    const adapter = new ACPAdapter(runAgentLoop, config);
    adapter.start();
    return;
  }

  if (flags.nonInteractive || flags.prompt || positional.length > 0) {
    const prompt = flags.prompt || positional.join(' ');
    await runNonInteractive(config, prompt);
    return;
  }

  await runTUI(config);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
