// SmallCode — Programmatic API (Runtime)
// Compiled from: src/api/index.ms
//
// Usage:
//   const { SmallCode } = require('smallcode');
//   const agent = new SmallCode({ model: 'gemma-4-e4b', baseUrl: 'http://localhost:1234/v1' });
//   const result = await agent.run("create a hello world script and run it");
//   console.log(result.response);
//   console.log(result.filesCreated);
//   console.log(result.toolCalls.length, 'tool calls');

const path = require('path');
const { EventEmitter } = require('events');
const { EarlyStopDetector } = require('../governor/early_stop');
const { getProfile } = require('../model/profiles');
const {
  escapeShellArg,
  buildCommand,
  safeResolvePath,
  sanitizeToolOutput,
} = require('../security/sanitize');

class SmallCode extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      model: config.model || process.env.SMALLCODE_MODEL || '',
      baseUrl: config.baseUrl || process.env.SMALLCODE_BASE_URL || 'http://localhost:1234/v1',
      provider: config.provider || process.env.SMALLCODE_PROVIDER || 'openai',
      apiKey: config.apiKey || process.env.OPENAI_API_KEY || null,
      contextWindow: config.contextWindow || 0,
      maxToolCalls: config.maxToolCalls || 50,
      timeout: config.timeout || 120000,
      cwd: config.cwd || process.cwd(),
      tools: config.tools || null, // null = all tools
      verbose: config.verbose || false,
    };

    this.earlyStop = new EarlyStopDetector();
    this.profile = getProfile(this.config.model, this.config.contextWindow);
    this._history = [];
  }

  /**
   * Run a single prompt through the agent loop.
   * Returns structured results with response, tool calls, and file changes.
   */
  async run(prompt) {
    const startTime = Date.now();
    this.earlyStop.newTurn();
    this._history = [];

    const result = {
      response: '',
      toolCalls: [],
      filesCreated: [],
      filesEdited: [],
      tokensUsed: { input: 0, output: 0, total: 0 },
      duration: 0,
      success: false,
      error: null,
    };

    try {
      const messages = [
        { role: 'system', content: this._buildSystemPrompt() },
        { role: 'user', content: prompt },
      ];

      let toolCallCount = 0;

      while (toolCallCount < this.config.maxToolCalls) {
        const response = await this._chatCompletion(messages);
        if (!response) {
          result.error = 'No response from model';
          break;
        }

        const message = response.choices?.[0]?.message;
        if (!message) break;

        // Recover tool calls embedded in text content (qwen2.5-coder etc.)
        // See src/tools/tool_call_extractor.js + issue #36.
        try {
          const { extractFromMessage } = require('../tools/tool_call_extractor');
          extractFromMessage(message, this._getTools());
        } catch {}

        // Track token usage
        if (response.usage) {
          result.tokensUsed.input += response.usage.prompt_tokens || 0;
          result.tokensUsed.output += response.usage.completion_tokens || 0;
          result.tokensUsed.total = result.tokensUsed.input + result.tokensUsed.output;
        }

        // Tool calls
        if (message.tool_calls && message.tool_calls.length > 0) {
          messages.push(message);

          for (const tc of message.tool_calls) {
            toolCallCount++;
            const toolName = tc.function.name;
            let toolArgs;
            try { toolArgs = JSON.parse(tc.function.arguments); } catch { toolArgs = {}; }

            this.emit('tool_start', { name: toolName, args: toolArgs });
            const toolStart = Date.now();

            const toolResult = await this._executeTool(toolName, toolArgs);
            const toolMs = Date.now() - toolStart;

            this.emit('tool_end', { name: toolName, result: toolResult, ms: toolMs });

            // Track file changes
            if (toolResult.action === 'Created') result.filesCreated.push(toolResult.path || toolArgs.path);
            if (toolResult.action === 'Edited' || toolResult.action === 'Updated') result.filesEdited.push(toolResult.path || toolArgs.path);

            result.toolCalls.push({
              name: toolName,
              args: toolArgs,
              result: toolResult.result || toolResult.error || '',
              error: toolResult.error || null,
              durationMs: toolMs,
            });

            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolResult.result || toolResult.error || '',
            });

            // Patch spiral detection
            if (toolName === 'patch' || toolName === 'read_and_patch') {
              const signal = this.earlyStop.recordPatchResult(toolArgs.path, !toolResult.error);
              if (signal) {
                this.emit('early_stop', signal);
                messages.push({ role: 'user', content: signal.injection });
                break;
              }
            }
          }
          continue;
        }

        // Text response (done)
        if (message.content) {
          result.response = message.content;
          this.emit('token', message.content);
        }
        break;
      }

      result.success = !result.error;
    } catch (err) {
      result.error = err.message;
      this.emit('error', err);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Get the detected model profile.
   */
  getProfile() {
    return this.profile;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  _buildSystemPrompt() {
    return `You are SmallCode, a coding assistant. You have tools to read, write, and edit files, run shell commands, and search code.
Rules:
- Use patch for edits (search-and-replace). Do NOT rewrite whole files.
- Be concise — show what you did, not lengthy explanations.
- Working directory: ${this.config.cwd}`;
  }

  async _chatCompletion(messages) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    if (this.config.baseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://github.com/Doorman11991/smallcode';
      headers['X-Title'] = 'SmallCode';
    }

    const tools = this._getTools();

    const body = {
      model: this.config.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: 0.1,
      max_tokens: 4096,
    };

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      // Redact provider error before throwing — some providers echo the
      // request back including Authorization headers on 401/403.
      throw new Error(`API error ${response.status}: ${sanitizeToolOutput(err).slice(0, 200)}`);
    }

    return response.json();
  }

  _getTools() {
    const fs = require('fs');
    // Minimal tool set for programmatic use
    const tools = [
      { type: 'function', function: { name: 'read_file', description: 'Read a file. Returns content with line numbers.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to cwd' } }, required: ['path'] } } },
      { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Full file content' } }, required: ['path', 'content'] } } },
      { type: 'function', function: { name: 'patch', description: 'Edit file by replacing old_str with new_str. old_str must match exactly ONE location.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File to edit' }, old_str: { type: 'string', description: 'Exact text to find' }, new_str: { type: 'string', description: 'Replacement text' } }, required: ['path', 'old_str', 'new_str'] } } },
      { type: 'function', function: { name: 'bash', description: 'Run a shell command. Returns stdout/stderr.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command' } }, required: ['command'] } } },
      { type: 'function', function: { name: 'search', description: 'Search file contents using regex. Returns matching lines.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern' } }, required: ['pattern'] } } },
      { type: 'function', function: { name: 'find_files', description: 'Find files matching a glob pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern' } }, required: ['pattern'] } } },
    ];

    if (this.config.tools) {
      return tools.filter(t => this.config.tools.includes(t.function.name));
    }
    return tools;
  }

  async _executeTool(name, args) {
    const fs = require('fs');
    const { execSync } = require('child_process');
    const cwd = this.config.cwd;

    switch (name) {
      case 'read_file': {
        const safe = safeResolvePath(args.path, cwd);
        if (!safe.ok) return { error: `read_file rejected: ${safe.reason}` };
        const filePath = safe.fullPath;
        if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const start = (args.start_line || 1) - 1;
        const end = args.end_line || lines.length;
        const numbered = lines.slice(start, end).map((l, i) => `${String(start + i + 1).padStart(4)}│ ${sanitizeToolOutput(l)}`).join('\n');
        return { result: `${args.path} (${lines.length} lines):\n${numbered}` };
      }

      case 'write_file': {
        const safe = safeResolvePath(args.path, cwd);
        if (!safe.ok) return { error: `write_file rejected: ${safe.reason}` };
        const filePath = safe.fullPath;
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const existed = fs.existsSync(filePath);
        fs.writeFileSync(filePath, args.content);
        const action = existed ? 'Updated' : 'Created';
        return { result: `${action} ${args.path} (${args.content.split('\n').length} lines)`, action, path: args.path };
      }

      case 'patch': {
        const safe = safeResolvePath(args.path, cwd);
        if (!safe.ok) return { error: `patch rejected: ${safe.reason}` };
        const filePath = safe.fullPath;
        if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
        let content = fs.readFileSync(filePath, 'utf-8');
        const count = content.split(args.old_str).length - 1;
        if (count === 0) return { error: `old_str not found in ${args.path}` };
        if (count > 1) return { error: `old_str matches ${count} locations. Be more specific.` };
        content = content.replace(args.old_str, args.new_str);
        fs.writeFileSync(filePath, content);
        return { result: `Patched ${args.path}`, action: 'Edited', path: args.path };
      }

      case 'bash': {
        let command = args.command;
        if (process.platform === 'win32') {
          command = command.replace(/^ls\b/, 'dir').replace(/^cat /, 'type ');
        }
        try {
          const output = execSync(command, { encoding: 'utf-8', timeout: 30000, cwd, maxBuffer: 1024 * 1024 });
          return { result: sanitizeToolOutput(output).slice(0, 3000) || '(no output)', command };
        } catch (e) {
          const output = (e.stdout || '') + (e.stderr || '');
          return { result: sanitizeToolOutput(output).slice(0, 2000) || sanitizeToolOutput(e.message || ''), error: `Exit code ${e.status || 'unknown'}`, command };
        }
      }

      case 'search': {
        try {
          const cmd = buildCommand('rg', ['--line-number', '--max-count', '10'], String(args.pattern || '')) + ' .';
          const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
          return { result: sanitizeToolOutput(output).slice(0, 3000) };
        } catch {
          return { result: 'No matches found.' };
        }
      }

      case 'find_files': {
        try {
          const cmd = 'rg --files --glob ' + escapeShellArg(String(args.pattern || ''))
            + ' --glob ' + escapeShellArg('!node_modules')
            + ' --glob ' + escapeShellArg('!.git');
          const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
          const files = output.trim().split('\n').filter(Boolean).slice(0, 30);
          return { result: files.length ? `Found ${files.length} files:\n${files.join('\n')}` : 'No files found.' };
        } catch {
          return { result: 'No files found.' };
        }
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }
}

module.exports = { SmallCode };
