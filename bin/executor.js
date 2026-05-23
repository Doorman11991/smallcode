// SmallCode — Tool Executor
// Executes tool calls from the model. Accepts a context object for shared state.
//
// Usage:
//   const { executeTool } = require('./executor');
//   const result = await executeTool(name, args, ctx);
//
// ctx: { _fullscreenRef, mcpCall, memoryStore, pluginLoader, mcpClient, flags, config, tui }

const path = require('path');
const fs = require('fs');
const {
  escapeShellArg,
  buildCommand,
  safeResolvePath,
  sanitizeToolOutput,
  stripAnsi: secStripAnsi,
} = require('../src/security/sanitize');
const { getShell } = require('../src/tools/shell_session');
const { getReadTracker } = require('../src/tools/read_tracker');
const { getSnapshotManager } = require('../src/session/snapshot');
const { getFileStateTracker } = require('../src/session/file_state');

// ─── RTK (Rust Token Killer) integration ─────────────────────────────────────
// Auto-rewrites supported bash commands through rtk for 60-90% token savings.
// Only activates if `rtk` binary is available on PATH.
// https://github.com/rtk-ai/rtk

let _rtkAvailable = null; // null = unchecked, true/false = cached result

function _checkRtk() {
  if (_rtkAvailable !== null) return _rtkAvailable;
  try {
    const { execSync } = require('child_process');
    execSync('rtk --version', { stdio: 'ignore', timeout: 2000 });
    _rtkAvailable = true;
  } catch {
    _rtkAvailable = false;
  }
  return _rtkAvailable;
}

// Commands RTK supports — maps regex to rtk subcommand.
// These produce significantly smaller output than raw commands.
const RTK_REWRITES = [
  // Git
  { re: /^git\s+(status|log|diff|add|commit|push|pull|fetch|branch|show)\b/, rewrite: (cmd) => 'rtk ' + cmd },
  // Test runners
  { re: /^(cargo\s+test|jest|vitest|pytest|go\s+test|npm\s+test|yarn\s+test|pnpm\s+test|rake\s+test|rspec)\b/, rewrite: (cmd) => 'rtk ' + cmd },
  // Build/lint
  { re: /^(cargo\s+build|cargo\s+clippy|tsc\b|eslint|ruff\s+check|golangci-lint|rubocop)\b/, rewrite: (cmd) => 'rtk ' + cmd },
  // File ops
  { re: /^(ls|find\s|grep\s|rg\s)/, rewrite: (cmd) => 'rtk ' + cmd },
  // Docker/k8s
  { re: /^docker\s+(ps|images|logs|compose\s+ps)\b/, rewrite: (cmd) => 'rtk ' + cmd },
  { re: /^kubectl\s+(get\s+pods|logs|get\s+services)\b/, rewrite: (cmd) => 'rtk ' + cmd },
  // npm/pnpm/yarn list
  { re: /^(npm\s+list|pnpm\s+list|yarn\s+list)\b/, rewrite: (cmd) => 'rtk ' + cmd },
];

function _rtkRewrite(command) {
  if (!_checkRtk()) return command;
  // Don't double-rewrite if already starts with rtk
  if (command.trimStart().startsWith('rtk ')) return command;
  for (const { re, rewrite } of RTK_REWRITES) {
    if (re.test(command.trimStart())) {
      return rewrite(command.trimStart());
    }
  }
  return command;
}

function showMiniDiff(tui, filePath, oldStr, newStr, lineNum) {
  const diff = tui.renderDiff(filePath, oldStr, newStr, lineNum);
  if (diff) console.log(diff);
}

async function executeTool(name, args, ctx) {
  const { _fullscreenRef, mcpCall, memoryStore, pluginLoader, mcpClient, flags, config, tui } = ctx;
  const { execSync } = require('child_process');
  const cwd = process.cwd();

  // Sanitize all string args — strip ANSI escape sequences the model may have
  // hallucinated into command strings (e.g. color codes in bash arguments).
  // Uses the comprehensive ANSI stripper from src/security/sanitize.js so
  // we cover OSC, DCS, 8-bit C1, and other escape forms too — not just CSI.
  function stripAnsi(str) { return secStripAnsi(str); }
  if (args && typeof args === 'object') {
    for (const key of Object.keys(args)) {
      if (typeof args[key] === 'string') args[key] = stripAnsi(args[key]);
    }
  }

  switch (name) {
    case 'read_file': {
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { error: `read_file rejected: ${safe.reason}` };
      const filePath = safe.fullPath;
      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path} (checked: ${filePath})` };
      // Mark as read so the write-guard (Feature 5) lets subsequent writes through
      try { getReadTracker().recordRead(filePath, cwd); } catch {}
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = (args.start_line || 1) - 1;
      const end = args.end_line || lines.length;
      const slice = lines.slice(start, end);
      // Sanitize before sending to the model: strip ANSI/control chars and
      // redact any secrets the file may contain (e.g. .env, token files).
      const safeSlice = slice.map(l => sanitizeToolOutput(l));
      const numbered = safeSlice.map((l, i) => `${String(start + i + 1).padStart(4)}│ ${l}`).join('\n');

      // Diff-based context (Feature #16): when SMALLCODE_DIFF_CONTEXT=true
      // and the model has already read this file, return a diff instead of the
      // full content. Falls back to full content if diff is too large or if the
      // file hasn't changed. Only applies when no line range is requested.
      if (!args.start_line && !args.end_line) {
        try {
          const tracker = getFileStateTracker();
          const result = tracker.record(filePath, content);
          if (result.mode === 'unchanged') {
            return { result: `${args.path} (${lines.length} lines — unchanged since last read, no diff)` };
          }
          if (result.mode === 'diff') {
            return { result: `${args.path} changes since last read (${result.fullLength} lines total):\n${sanitizeToolOutput(result.diff)}` };
          }
          // mode === 'full' — fall through to normal path below
        } catch {} // diff tracker failure is always non-fatal
      }

      // Feature 2: summarize large files (>200 lines, no line range requested)
      // This saves context by replacing the full file with signatures + key logic
      if (lines.length > 200 && !args.start_line && !args.end_line) {
        try {
          const { summarizeFileCompiled } = require('./features_adapter');
          if (summarizeFileCompiled) {
            const summary = await summarizeFileCompiled(args.path, content, 600);
            if (summary && summary.length > 50) {
              return { result: `${args.path} (${lines.length} lines — summarized):\n${sanitizeToolOutput(summary)}` };
            }
          }
        } catch {} // fall through to full content on any error
      }

      return { result: `${args.path} (${lines.length} lines):\n${numbered}` };
    }

    case 'write_file': {
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { error: `write_file rejected: ${safe.reason}` };
      const filePath = safe.fullPath;
      // Read-before-write guard — small models often overwrite files they
      // never read. First write to an unread existing file is refused with
      // a hint; second attempt allowed (so legitimate "fully replace" intents
      // succeed). Disable with SMALLCODE_WRITE_GUARD=false.
      const tracker = getReadTracker();
      const guard = tracker.checkWrite(filePath, cwd);
      if (!guard.ok) {
        return { error: guard.reason };
      }
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Guard against corrupted large writes — if content is suspiciously large
      // (>200KB) or empty after a JSON parse error, refuse rather than corrupt.
      if (!args.content && args.content !== '') {
        return { error: `write_file: content is missing or undefined for ${args.path}` };
      }
      // Content length guard — llama.cpp JSON parser fails at ~13k chars in tool_call arguments.
      // We enforce a limit well below that. For new large files, the model must use a
      // skeleton + patch strategy (instructed in the system prompt).
      const MAX_CONTENT_CHARS = 8000; // ~200 lines of dense code, well under llama.cpp's limit
      if (args.content.length > MAX_CONTENT_CHARS) {
        const lineCount = args.content.split('\n').length;
        return {
          error: `write_file: content too large (${lineCount} lines / ${Math.round(args.content.length/1024)}KB). ` +
            `llama.cpp cannot parse tool calls larger than ~8KB. ` +
            `Strategy: write a skeleton file first (imports + empty function stubs), ` +
            `then use multiple patch calls to fill in each section. ` +
            `Keep each write_file under 60 lines.`,
        };
      }
      const existed = fs.existsSync(filePath);
      const oldContent = existed ? fs.readFileSync(filePath, 'utf-8') : null;
      // Snapshot for auto-rollback (Feature 9). No-op if no checkpoint open.
      try { getSnapshotManager({ workdir: cwd }).note(filePath, oldContent); } catch {}
      fs.writeFileSync(filePath, args.content);
      tracker.recordWrite(filePath, cwd);
      // Update diff tracker so subsequent reads see the new state
      try { getFileStateTracker().recordWrite(filePath, args.content); } catch {}
      const lineCount = args.content.split('\n').length;
      const action = existed ? 'Updated' : 'Created';
      if (_fullscreenRef && existed && oldContent) {
        const preview = oldContent.split('\n').slice(0, 5).join('\n');
        const newPreview = args.content.split('\n').slice(0, 5).join('\n');
        _fullscreenRef.addDiff(args.path, preview + '\n...', newPreview + '\n...', 1);
      }
      return { result: `${action} ${args.path} (${lineCount} lines)`, action, path: args.path, lines: lineCount };
    }

    case 'append_file': {
      // append_file: lets the model build large files in chunks, avoiding
      // llama.cpp's ~13KB JSON parse limit that breaks large write_file calls.
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { error: `append_file rejected: ${safe.reason}` };
      const filePath = safe.fullPath;
      if (!args.content && args.content !== '') {
        return { error: 'append_file: content is missing' };
      }
      if (args.content.length > 8000) {
        return { error: `append_file: chunk too large (${Math.round(args.content.length/1024)}KB). Keep each append under 60 lines.` };
      }
      if (!fs.existsSync(filePath)) {
        return { error: `append_file: file not found: ${args.path}. Create it first with write_file.` };
      }
      const before = fs.readFileSync(filePath, 'utf-8');
      // Snapshot for auto-rollback (Feature 9) — record state before appending
      try { getSnapshotManager({ workdir: cwd }).note(filePath, before); } catch {}
      // Add newline separator if file doesn't end with one
      const sep = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
      const newContent = before + sep + args.content;
      fs.writeFileSync(filePath, newContent);
      try { getFileStateTracker().recordWrite(filePath, newContent); } catch {}
      try { getReadTracker().recordWrite(filePath, cwd); } catch {}
      const totalLines = newContent.split('\n').length;
      const addedLines = args.content.split('\n').length;
      return { result: `Appended ${addedLines} lines to ${args.path} (now ${totalLines} lines total)`, action: 'Appended', path: args.path };
    }

    case 'patch': {
      const __missing = ['path', 'old_str', 'new_str']
        .filter(k => typeof args[k] !== 'string');
      if (__missing.length) {
        return {
          error: `patch: missing or non-string arg(s): ${__missing.join(', ')}. ` +
                 `received: ${JSON.stringify(args).slice(0, 200)}`,
          kind: 'validation',
        };
      }
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { error: `patch rejected: ${safe.reason}` };
      const filePath = safe.fullPath;
      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path} (checked: ${filePath})` };
      // Patching counts as having read the file (it requires old_str matching)
      try { getReadTracker().recordRead(filePath, cwd); } catch {}
      let content = fs.readFileSync(filePath, 'utf-8');
      // Snapshot for auto-rollback (Feature 9). No-op if no checkpoint open.
      try { getSnapshotManager({ workdir: cwd }).note(filePath, content); } catch {}
      const count = content.split(args.old_str).length - 1;
      if (count === 0) {
        // MarrowScript Rank 7: semantic_merge — recover from old_str not found
        try {
          const { semanticMerge } = require('./features_adapter');
          if (semanticMerge) {
            const merged = await semanticMerge(args.path, args.new_str, content);
            if (merged && merged.length > 0) {
              // Strip ANSI codes from model-returned content before writing to disk
              const { stripAnsi: _stripAnsiMerge } = require('../src/security/sanitize');
              const cleanMerged = _stripAnsiMerge ? _stripAnsiMerge(merged) : merged;
              fs.writeFileSync(filePath, cleanMerged);
              try { getFileStateTracker().recordWrite(filePath, cleanMerged); } catch {}
              const oldLines = content.split('\n').length;
              const newLines = cleanMerged.split('\n').length;
              if (_fullscreenRef) {
                _fullscreenRef.addDiff(args.path, content.slice(0, 200), cleanMerged.slice(0, 200), 1);
              } else {
                showMiniDiff(tui, args.path, content.slice(0, 200), cleanMerged.slice(0, 200), 1);
              }
              return { result: `Patched ${args.path} via semantic merge (${oldLines} → ${newLines} lines)`, action: 'Edited', path: args.path, line: 1 };
            }
          }
        } catch {}
        return { error: `old_str not found in ${args.path}` };
      }
      if (count > 1) return { error: `old_str matches ${count} locations. Include more context.` };
      content = content.replace(args.old_str, args.new_str);
      fs.writeFileSync(filePath, content);
      try { getFileStateTracker().recordWrite(filePath, content); } catch {}
      const lineNum = content.slice(0, content.indexOf(args.new_str)).split('\n').length;
      const oldLines = args.old_str.split('\n').length;
      const newLines = args.new_str.split('\n').length;
      if (_fullscreenRef) {
        _fullscreenRef.addDiff(args.path, args.old_str, args.new_str, lineNum);
      } else {
        showMiniDiff(tui, args.path, args.old_str, args.new_str, lineNum);
      }
      return { result: `Patched ${args.path}: replaced ${oldLines} lines with ${newLines} lines at line ${lineNum}`, action: 'Edited', path: args.path, line: lineNum };
    }

    case 'bash': {
      let command = args.command;

      // RTK (Rust Token Killer) auto-rewrite — if rtk is on PATH, prefix supported
      // commands to compress output by 60-90% before it reaches the model's context.
      // Opt-out: set SMALLCODE_RTK=false in .env
      // Docs: https://github.com/rtk-ai/rtk
      if (process.env.SMALLCODE_RTK !== 'false') {
        command = _rtkRewrite(command);
      }

      // Detect commands that start long-running servers (will block and timeout).
      // IMPORTANT: only block on actual server indicators — NOT generic filenames
      // like main.py, index.js which are standard entry points that run and exit.
      // Match: files explicitly named *server*, *app* (as standalone), or framework
      // scripts that are always blocking (uvicorn, gunicorn, etc.)
      const blockingPatterns = /^(node|python|python3|ruby|php|go run|deno run|bun run)\s+.*\b(server\.(js|py|rb|php|ts)|app\.(js|py|rb|php|ts))\b/i;
      const explicitServers = /\b(uvicorn|gunicorn|rails\s+s|npm\s+start|yarn\s+start|npm\s+run\s+dev|python3?\s+-m\s+(flask|django|uvicorn|aiohttp\.web|fastapi)|puma|unicorn|passenger)\b/i;
      if (blockingPatterns.test(command) || explicitServers.test(command)) {
        // Check if it's actually a --check or test command (those are fine)
        if (!command.includes('--check') && !command.includes('--version') && !command.includes('test')) {
          return {
            result: `Refused: "${command}" would start a long-running server that blocks. Use "node --check <file>" to verify syntax, or describe what you want to test and I'll use a non-blocking approach.`,
            error: 'Blocking command detected',
            command,
          };
        }
      }

      // Detect scripts with interactive input (will EOF or block forever)
      const scriptMatch = command.match(/^(?:python3?|node|ruby)\s+["']?([^\s"']+)/);
      if (scriptMatch && !command.includes('--check') && !command.includes('-c') && !command.includes('-m')) {
        const targetFile = path.resolve(cwd, scriptMatch[1]);
        if (fs.existsSync(targetFile)) {
          const fc = fs.readFileSync(targetFile, 'utf-8');
          if (fc.includes('input(') || fc.includes('readline.question') || fc.includes('process.stdin.on')) {
            return {
              result: `Refused: "${command}" — file contains interactive input() calls that block in non-interactive mode. File created successfully. Verify syntax: python -m py_compile ${scriptMatch[1]}`,
              error: 'Interactive script detected',
              command,
            };
          }
        }
      }

      if (process.platform === 'win32') {
        command = command.replace(/^ls\b/, 'dir').replace(/^ls /, 'dir ').replace(/^cat /, 'type ').replace(/^rm -rf /, 'rmdir /s /q ').replace(/^rm /, 'del ').replace(/^touch /, 'echo.>').replace(/^cp /, 'copy ').replace(/^mv /, 'move ').replace(/^mkdir -p /, 'mkdir ');
      }
      if (flags && flags.verbose && _fullscreenRef) {
        _fullscreenRef.addTool('bash', 'ok', `$ ${command}`);
      }

      // Persistent shell session: by default ON, can be disabled with
      // SMALLCODE_SHELL_PERSIST=false. Maintains cwd, env vars, and shell
      // state across calls so `cd src` followed by `ls` works as expected.
      const usePersistent = process.env.SMALLCODE_SHELL_PERSIST !== 'false';
      if (usePersistent) {
        try {
          const shell = getShell({ cwd, timeout: 30000 });
          const result = await shell.run(command);
          const maxOutput = (config && config.context?.detected_window || 128000) < 64000 ? 1500 : 3000;
          const safeOutput = result.stdout || '';
          const trimmed = safeOutput.length > maxOutput
            ? safeOutput.slice(0, maxOutput - 500) + '\n...(truncated)...\n' + safeOutput.slice(-300)
            : safeOutput;
          if (flags && flags.verbose && _fullscreenRef && trimmed.trim()) {
            const lines = trimmed.split('\n').slice(0, 10);
            for (const line of lines) _fullscreenRef.addChat('system', '  ' + line);
          }
          if (result.timedOut) {
            return { result: trimmed || '(no output before timeout)', error: 'Timed out (killed after 30s)', command };
          }
          if (result.error) {
            return { result: trimmed, error: result.error, command };
          }
          if (result.exitCode !== 0) {
            // MarrowScript Rank 4: error_diagnosis — structured hint prepended to result
            let diagHint = '';
            try {
              const { diagnoseError } = require('./features_adapter');
              if (diagnoseError) {
                const diag = await diagnoseError(command, result.stdout || '', result.exitCode);
                if (diag && diag.suggestion) {
                  const loc = diag.file ? ` in ${diag.file}${diag.line ? ':' + diag.line : ''}` : '';
                  diagHint = `[ERROR-DIAGNOSIS] Type: ${diag.type}${loc}. Fix: ${diag.suggestion}\n\n`;
                }
              }
            } catch {}
            return { result: diagHint + (trimmed || '(no output)'), error: `Exit code ${result.exitCode}`, command };
          }
          return { result: trimmed || '(no output)', command };
        } catch (e) {
          // Fall through to one-shot execSync if persistent shell errors
        }
      }

      // Fallback: one-shot execSync (original behavior, no state retention)
      try {
        const output = execSync(command, { encoding: 'utf-8', timeout: 30000, cwd, maxBuffer: 1024 * 1024 });
        const maxOutput = (config && config.context?.detected_window || 128000) < 64000 ? 1500 : 3000;
        const safeOutput = sanitizeToolOutput(output);
        const trimmed = safeOutput.length > maxOutput ? safeOutput.slice(0, maxOutput - 500) + '\n...(truncated)...\n' + safeOutput.slice(-300) : safeOutput;
        if (flags && flags.verbose && _fullscreenRef && trimmed.trim()) {
          const lines = trimmed.split('\n').slice(0, 10);
          for (const line of lines) _fullscreenRef.addChat('system', '  ' + line);
        }
        return { result: trimmed || '(no output)', command };
      } catch (e) {
        const output = (e.stdout || '') + (e.stderr || '');
        const safeOutput = sanitizeToolOutput(output);
        const exitReason = (e.status === null || e.status === undefined) ? 'Timed out (killed after 30s)' : `Exit code ${e.status}`;
        if (flags && flags.verbose && _fullscreenRef && safeOutput.trim()) {
          const lines = safeOutput.split('\n').slice(0, 8);
          for (const line of lines) _fullscreenRef.addChat('system', '  ' + line);
        }
        // MarrowScript Rank 4: error_diagnosis — structured hint for execSync fallback too
        let diagHint = '';
        if (e.status !== null && e.status !== undefined) {
          try {
            const { diagnoseError } = require('./features_adapter');
            if (diagnoseError) {
              const diag = await diagnoseError(command, safeOutput, e.status);
              if (diag && diag.suggestion) {
                const loc = diag.file ? ` in ${diag.file}${diag.line ? ':' + diag.line : ''}` : '';
                diagHint = `[ERROR-DIAGNOSIS] Type: ${diag.type}${loc}. Fix: ${diag.suggestion}\n\n`;
              }
            }
          } catch {}
        }
        return { result: diagHint + (safeOutput.slice(0, 2000) || sanitizeToolOutput(e.message || '')), error: exitReason, command };
      }
    }

    case 'search': {
      try {
        // Resolve and contain the search path; default to cwd. This blocks
        // attacks like {pattern: 'foo', path: '/etc'} that would let the
        // model exfiltrate sensitive files outside the project.
        const safePath = args.path
          ? safeResolvePath(args.path, cwd)
          : { ok: true, fullPath: '.' };
        if (!safePath.ok) return { error: `search rejected: ${safePath.reason}` };
        const cmd = buildCommand('rg', ['--line-number', '--max-count', '10', '-C', '1'], String(args.pattern || ''))
          + ' ' + escapeShellArg(safePath.fullPath || '.');
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
        return { result: sanitizeToolOutput(output).slice(0, 3000) };
      } catch { return { result: 'No matches found.' }; }
    }

    case 'find_files': {
      try {
        // Smart listing (Feature #17): if no glob pattern, use scored file tree
        // instead of dumping everything. With a pattern, use rg as before.
        if (!args.pattern || args.pattern === '*' || args.pattern === '**') {
          const { formatSmartListing } = require('../src/tools/file_tree');
          const hint = args.hint || ''; // caller can pass a hint for keyword scoring
          const listing = formatSmartListing(cwd, hint, { max: 50 });
          return { result: listing };
        }
        const cmd = 'rg --files --glob ' + escapeShellArg(String(args.pattern || ''))
          + ' --glob ' + escapeShellArg('!node_modules')
          + ' --glob ' + escapeShellArg('!.git');
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
        const files = output.trim().split('\n').filter(Boolean).slice(0, 30);
        return { result: files.length ? `Found ${files.length} files:\n${files.join('\n')}` : 'No files found.' };
      } catch { return { result: 'No files found.' }; }
    }

    case 'list_projects': {
      const listResult = await mcpCall('tools/call', { name: 'list_repos', arguments: {} });
      if (listResult && listResult.content) {
        try {
          const data = JSON.parse(listResult.content[0]?.text || '{}');
          const repos = data.repos || [];
          if (repos.length === 0) return { result: 'No projects indexed yet. The code graph is empty.' };
          let output = `Workspace: ${repos.length} indexed projects\n\n`;
          for (const r of repos) {
            output += `• ${r.name} — ${r.file_count || '?'} files, ${r.symbol_count || '?'} symbols, ${(r.languages || []).slice(0, 4).join(', ') || '?'}\n`;
          }
          return { result: output };
        } catch (e) { return { result: listResult.content[0]?.text || 'Failed to parse repo list.' }; }
      }
      try {
        const { formatSmartListing } = require('../src/tools/file_tree');
        const listing = formatSmartListing(process.cwd(), '', { max: 40 });
        return { result: `Files in ${process.cwd()}:\n${listing}` };
      } catch {
        const entries = fs.readdirSync(process.cwd(), { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
        return { result: `Projects in ${process.cwd()}:\n${dirs.map(d => `  - ${d.name}/`).join('\n')}` };
      }
    }

    case 'graph_search': {
      const maxTokens = args.max_tokens || 4000;
      const graphResult = await mcpCall('tools/call', { name: 'search_graph', arguments: { query: args.query, max_tokens: maxTokens } });
      if (graphResult && graphResult.content) {
        const text = graphResult.content.map(c => c.text || '').join('\n');
        return { result: sanitizeToolOutput(text) || 'No results from code graph.' };
      }
      try {
        const cmd = buildCommand('rg', ['--line-number', '--max-count', '5'], String(args.query || '')) + ' .';
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
        return { result: sanitizeToolOutput(output).slice(0, 3000) };
      } catch { return { result: 'No matches found in code graph or files.' }; }
    }

    case 'explain_symbol': {
      const graphResult = await mcpCall('tools/call', { name: 'explain_symbol', arguments: { symbol: args.symbol } });
      if (graphResult && graphResult.content) {
        const text = graphResult.content.map(c => c.text || '').join('\n');
        return { result: sanitizeToolOutput(text) || `Symbol "${args.symbol}" not found in code graph.` };
      }
      try {
        // Restrict the symbol arg to identifier-safe characters before
        // building the regex to defend against shell metacharacters and
        // regex DoS via catastrophic backtracking.
        const sym = String(args.symbol || '').slice(0, 200);
        if (!/^[A-Za-z_][A-Za-z0-9_:.$-]*$/.test(sym)) {
          return { result: `Symbol "${sym}" is not a valid identifier.` };
        }
        const cmd = 'rg --line-number ' + escapeShellArg(`\\b${sym}\\b`) + ' . --max-count 10';
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
        return { result: sanitizeToolOutput(`References to ${sym}:\n${output.slice(0, 2000)}`) };
      } catch { return { result: `Symbol "${args.symbol}" not found.` }; }
    }

    case 'read_and_patch': {
      const __missing = ['path', 'old_str', 'new_str']
        .filter(k => typeof args[k] !== 'string');
      if (__missing.length) {
        return {
          error: `read_and_patch: missing or non-string arg(s): ${__missing.join(', ')}. ` +
                 `received: ${JSON.stringify(args).slice(0, 200)}`,
          kind: 'validation',
        };
      }
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { error: `read_and_patch rejected: ${safe.reason}` };
      const filePath = safe.fullPath;
      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
      let content = fs.readFileSync(filePath, 'utf-8');
      const count = content.split(args.old_str).length - 1;
      if (count === 0) {
        const lines = content.split('\n').slice(0, 50);
        const numbered = lines.map((l, i) => `${(i+1).toString().padStart(4)}| ${sanitizeToolOutput(l)}`).join('\n');
        return { error: `old_str not found. File content:\n${numbered}` };
      }
      if (count > 1) return { error: `old_str matches ${count} locations. Be more specific.` };
      content = content.replace(args.old_str, args.new_str);
      fs.writeFileSync(filePath, content);
      const lineNum = content.slice(0, content.indexOf(args.new_str)).split('\n').length;
      showMiniDiff(tui, args.path, args.old_str, args.new_str, lineNum);
      return { result: `Read and patched ${args.path} at line ${lineNum}`, action: 'Edited', path: args.path, line: lineNum };
    }

    case 'create_and_run': {
      const __missing = ['path', 'content']
        .filter(k => typeof args[k] !== 'string');
      if (__missing.length) {
        return {
          error: `create_and_run: missing or non-string arg(s): ${__missing.join(', ')}. ` +
                 `received: ${JSON.stringify(args).slice(0, 200)}`,
          kind: 'validation',
        };
      }
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { error: `create_and_run rejected: ${safe.reason}` };
      const filePath = safe.fullPath;
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Apply the same 8KB guard as write_file — llama.cpp can't parse larger tool calls
      if (args.content && args.content.length > 8000) {
        return { error: `create_and_run: content too large (${args.content.split('\n').length} lines). Use write_file (skeleton) + append_file (sections) + bash to run.` };
      }
      fs.writeFileSync(filePath, args.content || '');
      const lines = args.content.split('\n').length;
      let output = `Created ${args.path} (${lines} lines)`;
      let cmdError = false;
      if (args.command) {
        // Check if the file contains interactive input calls that would block
        const hasInteractive = args.content && (
          args.content.includes('input(') ||     // Python input()
          args.content.includes('readline') ||    // Node readline
          args.content.includes('process.stdin') || // Node stdin
          args.content.includes('Scanner(') ||    // Java Scanner
          args.content.includes('gets') ||        // Ruby gets
          args.content.includes('read()')         // generic read
        );
        if (hasInteractive) {
          output += `\n⚠ File contains interactive input calls (input/readline/stdin). Skipping execution — the script would hang waiting for user input. Use node --check or python -c "import py_compile; py_compile.compile('${args.path}')" to verify syntax instead.`;
          return { result: output, action: 'Created', path: args.path, lines };
        }
        // Also check for server-start patterns (same conservative matching as bash case)
        const blockingPatterns = /^(node|python|python3|ruby|php)\s+.*\b(server\.(js|py|rb|php)|app\.(js|py|rb|php))\b/i;
        const explicitServers = /\b(uvicorn|gunicorn|flask|django|express|fastify|npm\s+start)\b/i;
        if (blockingPatterns.test(args.command) || explicitServers.test(args.command)) {
          if (!args.command.includes('--check') && !args.command.includes('test')) {
            output += `\n⚠ Command would start a long-running server. Skipping execution.`;
            return { result: output, action: 'Created', path: args.path, lines };
          }
        }
        try {
          const cmdOut = execSync(args.command, { encoding: 'utf-8', timeout: 30000, cwd, maxBuffer: 1024*1024 });
          output += `\n$ ${args.command}\n${cmdOut.slice(0, 2000)}`;
        } catch (e) {
          cmdError = true;
          const errOut = (e.stdout || '') + (e.stderr || e.message || '');
          output += `\n$ ${args.command}\n${(e.status === null || e.status === undefined) ? 'TIMED OUT' : 'EXIT CODE ' + (e.status || 1)} — FAILED:\n${errOut.slice(0, 2000)}`;
        }
      }
      return { result: output, action: 'Created', path: args.path, lines, error: cmdError ? `Command failed: ${args.command}` : null };
    }

    case 'find_and_read': {
      try {
        const cmd = 'rg --files --glob ' + escapeShellArg(String(args.pattern || ''))
          + ' --glob ' + escapeShellArg('!node_modules')
          + ' --glob ' + escapeShellArg('!.git');
        const found = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
        const files = found.trim().split('\n').filter(Boolean);
        if (files.length === 0) return { result: 'No files found matching: ' + args.pattern };
        const target = files[0];
        // Re-validate the target through safeResolvePath. ripgrep --files
        // can in theory follow symlinks outside cwd; we want to refuse
        // serving up content from outside the project.
        const safeTarget = safeResolvePath(target, cwd);
        if (!safeTarget.ok) return { error: `find_and_read rejected: ${safeTarget.reason}` };
        const content = fs.readFileSync(safeTarget.fullPath, 'utf-8');
        const maxLines = args.read_lines || 50;
        const lines = content.split('\n').slice(0, maxLines);
        const numbered = lines.map((l, i) => `${(i+1).toString().padStart(4)}| ${sanitizeToolOutput(l)}`).join('\n');
        let output = `Found ${files.length} files. Reading ${target} (${content.split('\n').length} lines):\n${numbered}`;
        if (files.length > 1) output += `\n\nOther matches: ${files.slice(1, 5).join(', ')}`;
        return { result: output };
      } catch { return { result: 'No files found matching: ' + args.pattern }; }
    }

    case 'search_and_read': {
      try {
        const readCtx = Number.isInteger(args.read_context) && args.read_context > 0 && args.read_context < 200
          ? args.read_context
          : 10;
        const cmd = buildCommand(
          'rg',
          ['--line-number', '-C', String(readCtx), '--max-count', '3'],
          String(args.pattern || ''),
        ) + ' . --glob ' + escapeShellArg('!node_modules') + ' --glob ' + escapeShellArg('!.git');
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
        return { result: sanitizeToolOutput(output).slice(0, 4000) || 'No matches.' };
      } catch { return { result: 'No matches found for: ' + args.pattern }; }
    }

    case 'run': {
      // Check if the target file has interactive input that would block
      const runMatch = args.command.match(/^(?:python3?|node|ruby)\s+["']?([^\s"']+)/);
      if (runMatch) {
        const targetFile = path.resolve(cwd, runMatch[1]);
        if (fs.existsSync(targetFile)) {
          const fileContent = fs.readFileSync(targetFile, 'utf-8');
          if (fileContent.includes('input(') || fileContent.includes('readline') || fileContent.includes('process.stdin')) {
            return {
              result: `Refused: "${args.command}" — the file contains interactive input calls (input/readline/stdin) which cannot work in non-interactive mode. The file was created successfully. To verify syntax, use: python -m py_compile <file> or node --check <file>`,
              error: 'Interactive script detected',
              command: args.command,
            };
          }
        }
      }
      const timeout = (args.timeout || 30) * 1000;
      try {
        const output = execSync(args.command, { encoding: 'utf-8', timeout, cwd, maxBuffer: 1024*1024 });
        return { result: sanitizeToolOutput(output).slice(0, 3000) || '(completed with no output)', command: args.command };
      } catch (e) {
        const errOut = (e.stdout || '') + (e.stderr || e.message || '');
        const exitReason = (e.status === null || e.status === undefined)
          ? `Timed out (killed after ${args.timeout || 30}s)`
          : `Exit code ${e.status || 1}`;
        return { result: `${exitReason.toUpperCase()} — FAILED:\n${sanitizeToolOutput(errOut).slice(0, 2500)}`, error: `Command failed: ${exitReason}`, command: args.command };
      }
    }

    case 'memory_load':
    case 'memory_remember':
    case 'memory_list':
    case 'memory_forget': {
      if (name === 'memory_load') {
        const task = args.task || '';
        const maxTokens = args.max_tokens || 2000;
        // Handle both budget-aware-mcp format ({objects, tokens_used}) and
        // fallback MemoryStore format (plain array).
        const raw = memoryStore.loadForTask(task, maxTokens);
        const objects = Array.isArray(raw) ? raw : (raw?.objects || []);
        const tokens_used = Array.isArray(raw) ? objects.length * 50 : (raw?.tokens_used || 0);
        if (objects.length === 0) return { result: 'No relevant memory found.' };
        const formatted = objects.map(o => `[${o.type}] ${o.title}: ${o.content}`).join('\n\n');
        return { result: `Loaded ${objects.length} memories (${tokens_used} tokens):\n\n${formatted}` };
      }
      if (name === 'memory_remember') {
        // Support both the budget-aware-mcp API (object arg) and fallback (positional).
        let obj;
        if (typeof memoryStore.remember === 'function' && memoryStore.remember.length >= 3) {
          // Fallback MemoryStore: remember(type, title, content, opts)
          obj = memoryStore.remember(args.type || 'context', args.title || '', args.content || '', { tags: args.tags || [] });
        } else {
          // budget-aware-mcp: remember({ type, title, content, tags, ... })
          obj = memoryStore.remember({ type: args.type || 'context', title: args.title || '', content: args.content || '', tags: args.tags || [], symbols: args.symbols || [], files: args.files || [] });
        }
        if (obj.duplicate) return { result: `Already known (confirmed existing: ${obj.existing_id})` };
        return { result: `Remembered [${obj.type}] "${obj.title}" (${obj.id})` };
      }
      if (name === 'memory_list') {
        const objects = args.type ? memoryStore.byType(args.type) : memoryStore.all();
        if (objects.length === 0) return { result: 'No memory stored.' };
        return { result: objects.map(o => `[${o.id}] (${o.type}) ${o.title}`).join('\n') };
      }
      if (name === 'memory_forget') {
        const ok = memoryStore.forget(args.id);
        return { result: ok ? `Deleted ${args.id}` : `Not found: ${args.id}` };
      }
      return { result: '' };
    }

    case 'bone_compile': {
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { error: `bone_compile rejected: ${safe.reason}` };
      const bonePath = safe.fullPath;
      if (!fs.existsSync(bonePath)) return { error: `File not found: ${args.path}` };
      if (!args.path.endsWith('.bone')) return { error: `Expected a .bone file, got: ${args.path}` };
      // Restrict the target string to a known whitelist — it gets passed
      // straight to the compiler CLI, so an unrestricted value is a
      // potential injection vector.
      const allowedTargets = new Set(['express', 'nakama', 'prisma', 'sqlite']);
      const target = String(args.target || 'express');
      if (!allowedTargets.has(target)) {
        return { error: `bone_compile: invalid target. Allowed: ${[...allowedTargets].join(', ')}` };
      }
      const compilerPaths = [path.resolve(__dirname, '..', 'node_modules', 'bonescript-compiler', 'dist', 'cli.js'), path.resolve(__dirname, '..', '..', 'BoneScript', 'compiler', 'dist', 'cli.js')];
      let compiler = null;
      for (const cp of compilerPaths) { if (fs.existsSync(cp)) { compiler = cp; break; } }
      if (!compiler) return { error: 'BoneScript compiler not found.' };
      try {
        const cmd = 'node ' + escapeShellArg(compiler) + ' compile ' + escapeShellArg(bonePath) + ' --target ' + escapeShellArg(target);
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 30000, cwd });
        return { result: `Compiled ${args.path} → output/\n${sanitizeToolOutput(output).slice(0, 2000)}`, action: 'Created', path: 'output/' };
      } catch (e) {
        return { error: `BoneScript compile failed:\n${sanitizeToolOutput((e.stdout || '') + (e.stderr || e.message || '')).slice(0, 2000)}` };
      }
    }

    case 'bone_check': {
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { error: `bone_check rejected: ${safe.reason}` };
      const bonePath = safe.fullPath;
      if (!fs.existsSync(bonePath)) return { error: `File not found: ${args.path}` };
      if (!args.path.endsWith('.bone')) return { error: `Expected a .bone file, got: ${args.path}` };
      const compilerPaths = [path.resolve(__dirname, '..', 'node_modules', 'bonescript-compiler', 'dist', 'cli.js'), path.resolve(__dirname, '..', '..', 'BoneScript', 'compiler', 'dist', 'cli.js')];
      let compiler = null;
      for (const cp of compilerPaths) { if (fs.existsSync(cp)) { compiler = cp; break; } }
      if (!compiler) return { error: 'BoneScript compiler not found.' };
      try {
        const cmd = 'node ' + escapeShellArg(compiler) + ' check ' + escapeShellArg(bonePath);
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd });
        return { result: sanitizeToolOutput(output).trim() || '✓ No errors found.' };
      } catch (e) {
        return { error: `BoneScript validation errors:\n${sanitizeToolOutput((e.stdout || '') + (e.stderr || e.message || '')).slice(0, 2000)}` };
      }
    }

    case 'web_search': {
      if (process.env.SMALLCODE_WEB_BROWSE !== 'true') return { error: 'Web browsing disabled. Set SMALLCODE_WEB_BROWSE=true.' };
      const { webSearch } = require('../src/tools/builtin/web_browse');
      const results = await webSearch(args.query, 5);
      return { result: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n') || 'No results found.' };
    }

    case 'web_fetch': {
      if (process.env.SMALLCODE_WEB_BROWSE !== 'true') return { error: 'Web browsing disabled. Set SMALLCODE_WEB_BROWSE=true.' };
      const { webFetch } = require('../src/tools/builtin/web_browse');
      const content = await webFetch(args.url, 5000);
      return { result: content || 'Failed to fetch URL.' };
    }

    case 'select_category': {
      const category = args.category || 'read';
      return { result: `Category: ${category}. Proceed with your tool call.`, category };
    }

    case 'contract_status':
    case 'contract_create':
    case 'contract_assert_pass':
    case 'contract_assert_fail':
    case 'contract_assert_skip': {
      try {
        const { executeContractTool } = require('../src/session/contract_tools');
        return await executeContractTool(name, args, { cwd });
      } catch (e) {
        return { error: `${name} failed: ${e.message}` };
      }
    }

    default: {
      if (mcpClient && mcpClient.isMCPTool(name)) {
        const mcpResult = await mcpClient.callTool(name, args);
        if (mcpResult.error) return { error: mcpResult.error };
        return { result: mcpResult.result || '(no output)' };
      }
      if (pluginLoader) {
        const pluginResult = await pluginLoader.executeTool(name, args);
        if (pluginResult !== null) {
          if (pluginResult.error) return { error: pluginResult.error };
          return { result: typeof pluginResult === 'string' ? pluginResult : JSON.stringify(pluginResult) };
        }
      }
      return { error: `Unknown tool: ${name}` };
    }
  }
}

module.exports = { executeTool };
