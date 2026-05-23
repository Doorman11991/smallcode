// SmallCode — TUI Commands
// All /slash commands live here

const fs = require('fs');
const path = require('path');
const tui = require('./tui');
const chalk = tui.chalk;

module.exports = function createCommandHandler(config, conversationHistory, improvementAttempts, runAgentLoop, runValidation, MAX_IMPROVE_ITERATIONS, memoryStore, escalationEngine, tokenMonitor) {

  return async function handleCommand(cmd, rl) {
    const parts = cmd.split(' ');

    switch (parts[0]) {
      case '/quit': case '/q': case '/exit':
        rl.close();
        return;

      case '/clear':
        conversationHistory.length = 0;
        Object.keys(improvementAttempts).forEach(k => delete improvementAttempts[k]);
        console.log(chalk.green('  ✓ Session cleared.'));
        console.log('');
        rl.prompt();
        return;

      case '/model': {
        if (parts.length < 2) {
          // Show current model + fetch available models from endpoint
          console.log(`  Current: ${chalk.cyan(config.model.name)}`);
          console.log(`  Endpoint: ${chalk.gray(config.model.baseUrl)}`);
          console.log('');
          process.stdout.write(chalk.gray('  Fetching available models... '));
          try {
            // Build auth headers — required by OpenWebUI and other authenticated endpoints
            const modelListHeaders = { 'Content-Type': 'application/json' };
            const apiKey = process.env.SMALLCODE_API_KEY || process.env.OPENAI_API_KEY ||
              process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || config.model.apiKey;
            if (apiKey) modelListHeaders['Authorization'] = `Bearer ${apiKey}`;

            const resp = await fetch(`${config.model.baseUrl}/models`, { headers: modelListHeaders });
            if (resp.ok) {
              const data = await resp.json();
              const models = data.data || data.models || [];
              console.log(chalk.green(`${models.length} found`));
              console.log('');
              for (const m of models) {
                const id = m.id || m.name || '';
                const active = id === config.model.name ? chalk.green(' ← active') : '';
                console.log(`    ${chalk.white(id)}${active}`);
              }
              console.log('');
              console.log(chalk.gray('  Switch: /model <name>'));
            } else {
              console.log(chalk.red(`failed (HTTP ${resp.status})`));
            }
          } catch (e) {
            console.log(chalk.red(`error: ${e.message}`));
          }
        } else {
          const newModel = parts.slice(1).join(' ');
          config.model.name = newModel;
          console.log(`  ${chalk.green('✓')} Switched to ${chalk.cyan(newModel)}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/endpoint': {
        if (parts.length < 2) {
          console.log(`  Current: ${chalk.gray(config.model.baseUrl)}`);
          console.log(chalk.gray('  Switch: /endpoint http://host:port/v1'));
        } else {
          config.model.baseUrl = parts[1];
          console.log(`  ${chalk.green('✓')} Endpoint: ${chalk.gray(parts[1])}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/stats':
        console.log(`  Model:    ${chalk.cyan(config.model.name)}`);
        console.log(`  Endpoint: ${chalk.gray(config.model.baseUrl)}`);
        console.log(`  History:  ${chalk.white(String(conversationHistory.length))} messages`);
        console.log(`  Files:    ${chalk.white(String(Object.keys(improvementAttempts).filter(k => k !== '__bash').length))} tracked`);
        console.log(`  Dir:      ${chalk.gray(process.cwd())}`);
        if (tokenMonitor) {
          console.log(`  Tokens:   ${chalk.white(tokenMonitor.formatShort())}`);
        }
        console.log('');
        rl.prompt();
        return;

      case '/tokens': {
        if (!tokenMonitor) {
          console.log(chalk.gray('  Token monitor not initialized.'));
        } else {
          console.log(chalk.bold('  ' + tokenMonitor.formatFull().split('\n').join('\n  ')));
          // Feature 3: show policy budget state
          try {
            const { getBudgetState } = require('./features_adapter');
            if (getBudgetState) {
              const bs = getBudgetState();
              if (bs) {
                console.log(`  Policy:    turns ${bs.run_turn.calls}/30 this min | tokens ${Math.round(bs.per_user_tokens.tokens/1000)}k/500k this hr`);
              }
            }
          } catch {}
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/budget': {
        const maxCtx = config.context?.detected_window || 128000;
        const budgetPct = config.context?.max_budget_pct || 70;
        const maxBudget = Math.round(maxCtx * (budgetPct / 100));
        const currentEst = conversationHistory.reduce((sum, m) => {
          const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
          return sum + Math.ceil(c.length / 4);
        }, 0);
        const usage = Math.round((currentEst / maxBudget) * 100);
        const bar = '█'.repeat(Math.min(20, Math.round(usage / 5))) + '░'.repeat(Math.max(0, 20 - Math.round(usage / 5)));
        console.log(chalk.bold('  Context Budget'));
        console.log(`  Window:    ${chalk.white(String(maxCtx))} tokens`);
        console.log(`  Budget:    ${chalk.white(String(maxBudget))} tokens (${budgetPct}%)`);
        console.log(`  Used:      ${chalk.white(String(currentEst))} tokens (~${usage}%)`);
        console.log(`  [${usage > 80 ? chalk.red(bar) : usage > 50 ? chalk.yellow(bar) : chalk.green(bar)}]`);
        if (tokenMonitor) {
          const m = tokenMonitor.getMetrics();
          console.log(`  Compacts:  ${chalk.white(String(m.compactions))} | Evictions: ${chalk.white(String(m.evictions))}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/trace': {
        const { TraceRecorder } = require('./trace_recorder');
        const tr = new TraceRecorder(process.cwd());
        const sub = parts[1];

        if (!sub || sub === 'list') {
          const traces = tr.list();
          if (traces.length === 0) {
            console.log(chalk.gray('  No traces recorded yet.'));
            console.log(chalk.gray('  Traces are recorded automatically for each turn.'));
          } else {
            console.log(chalk.bold(`  Traces (${traces.length}):`));
            for (const t of traces.slice(0, 15)) {
              const tok = t.tokens ? `${t.tokens.prompt + t.tokens.completion}tok` : '?';
              console.log(`    ${chalk.cyan(t.id)} ${chalk.white(t.prompt)} ${chalk.gray(`${t.steps} steps, ${tok}, ${t.durationMs}ms`)}`);
            }
          }
        } else if (sub === 'show') {
          const id = parts[2];
          if (!id) { console.log(chalk.gray('  Usage: /trace show <id>')); }
          else {
            const trace = tr.load(id);
            if (!trace) { console.log(chalk.red(`  Trace ${id} not found.`)); }
            else {
              console.log(chalk.bold(`  Trace ${trace.id}`));
              console.log(`  Prompt: ${chalk.white(trace.prompt.slice(0, 80))}`);
              console.log(`  Model:  ${chalk.cyan(trace.model)}`);
              console.log(`  Tokens: ${trace.tokens.prompt}p + ${trace.tokens.completion}c`);
              console.log(`  Steps:`);
              for (const step of trace.steps) {
                if (step.type === 'tool_call') {
                  console.log(`    ${chalk.green('⚙')} ${step.name} (${step.durationMs}ms)`);
                } else if (step.type === 'validation') {
                  const mark = step.passed ? chalk.green('✓') : chalk.red('✗');
                  console.log(`    ${mark} validate ${step.filePath}`);
                }
              }
            }
          }
        } else if (sub === 'test') {
          const id = parts[2];
          if (!id) { console.log(chalk.gray('  Usage: /trace test <id>')); }
          else {
            const testCode = tr.generateTest(id);
            if (!testCode) { console.log(chalk.red(`  Cannot generate test from trace ${id}.`)); }
            else {
              const outPath = `.test-workspace/trace_${id}.test.js`;
              fs.writeFileSync(path.join(process.cwd(), outPath), testCode);
              console.log(chalk.green(`  ✓ Generated ${outPath}`));
            }
          }
        } else {
          console.log(chalk.gray('  /trace list          List recorded traces'));
          console.log(chalk.gray('  /trace show <id>     Show trace details'));
          console.log(chalk.gray('  /trace test <id>     Generate test from trace'));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/eval': {
        const { EvalRunner } = require('./eval_runner');
        const evalRunner = new EvalRunner(config);
        const suite = parts[1] || 'classify_accuracy';
        console.log(chalk.gray(`  Running evaluation: ${suite}...`));
        const results = await evalRunner.run(suite);
        if (results.error) {
          console.log(chalk.red(`  ${results.error}`));
        } else {
          console.log(EvalRunner.format(results));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/diff': {
        const { execSync } = require('child_process');
        try {
          const diff = execSync('git diff --stat', { encoding: 'utf-8', cwd: process.cwd() });
          if (diff.trim()) {
            console.log(chalk.bold('  Changes:'));
            for (const line of diff.trim().split('\n')) {
              console.log(`  ${line}`);
            }
          } else {
            console.log(chalk.gray('  No uncommitted changes.'));
          }
        } catch {
          console.log(chalk.gray('  Not a git repo.'));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/git': {
        const gitArgs = parts.slice(1);
        if (gitArgs.length === 0) {
          console.log(chalk.gray('  /git status │ /git log │ /git diff │ /git commit -m "msg"'));
          console.log('');
          rl.prompt();
          return;
        }
        // Use execFileSync with arg array to prevent shell injection.
        // /git status; rm -rf / would previously execute the rm command.
        const { execFileSync } = require('child_process');
        try {
          const output = execFileSync('git', gitArgs, { encoding: 'utf-8', cwd: process.cwd(), timeout: 10000 });
          console.log(output);
        } catch (e) {
          console.log(chalk.red(`  ${(e.stdout || '') + (e.stderr || e.message || '')}`));
        }
        rl.prompt();
        return;
      }

      case '/loop': {
        const targetFile = parts[1];
        if (!targetFile) {
          console.log(chalk.gray('  Usage: /loop <filepath>'));
          console.log('');
          rl.prompt();
          return;
        }
        const validation = runValidation(targetFile);
        if (!validation) {
          console.log(chalk.gray(`  No validator for ${targetFile}`));
        } else if (validation.passed) {
          console.log(`  ${chalk.green('✓')} ${targetFile} — no errors`);
        } else {
          console.log(tui.improvementLoop(validation.errors, 1, MAX_IMPROVE_ITERATIONS));
          console.log('');
          await runAgentLoop(`Fix these errors in ${targetFile}:\n${validation.errors.join('\n')}`, config);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/memory': {
        // Use the same memoryStore instance the tools use (budget-aware-mcp SQLite store)
        const sub = parts[1];
        if (!sub || sub === 'list') {
          try {
            const stats = memoryStore.stats();
            if (stats.total === 0) {
              console.log(chalk.gray('  No memory stored. The model will save decisions/workflows/gotchas as it works.'));
            } else {
              console.log(chalk.bold(`  Project memory (${stats.total} objects):`));
              const objects = memoryStore.all();
              for (const o of objects) {
                console.log(`    ${chalk.cyan(`[${o.type}]`)} ${chalk.white(o.title)} ${chalk.gray(`(${o.id})`)}`);
              }
            }
          } catch (e) {
            console.log(chalk.gray(`  Memory error: ${e.message}`));
          }
        } else if (sub === 'clear') {
          try {
            const objs = memoryStore.all();
            for (const o of objs) memoryStore.forget(o.id);
            console.log(chalk.green('  ✓ Memory cleared.'));
          } catch (e) {
            console.log(chalk.gray(`  Error: ${e.message}`));
          }
        } else {
          console.log(chalk.gray('  /memory         List stored memory'));
          console.log(chalk.gray('  /memory clear   Clear all memory'));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/compact': {
        if (conversationHistory.length > 10) {
          const removed = conversationHistory.splice(0, conversationHistory.length - 6);
          console.log(`  ${chalk.green('✓')} Removed ${removed.length} old messages, kept last 6.`);
        } else {
          console.log(chalk.gray(`  Short history (${conversationHistory.length} msgs), nothing to compact.`));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/escalation': {
        if (!escalationEngine) {
          console.log(chalk.gray('  Escalation engine not initialized.'));
        } else if (!escalationEngine.enabled) {
          console.log(chalk.gray('  Escalation: disabled'));
          console.log(chalk.gray('  To enable, set ANTHROPIC_API_KEY or OPENAI_API_KEY env var'));
          console.log(chalk.gray('  Or add [escalation] section to smallcode.toml'));
        } else {
          console.log(`  ${chalk.magenta('⬆')} Escalation: ${chalk.green('enabled')}`);
          console.log(`  Provider: ${chalk.cyan(escalationEngine.provider)} (${escalationEngine.model})`);
          console.log(`  Used: ${escalationEngine.escalationCount}/${escalationEngine.maxEscalationsPerSession} this session`);
          console.log(`  Confirm: ${escalationEngine.confirmBeforeEscalate ? 'yes (will ask)' : 'no (auto)'}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/profile': {
        const { getProfile } = require('../src/model/profiles');
        const { getRoutingMode, estimateSavings } = require('../src/tools/two_stage_router');
        const profile = getProfile(config.model.name, config.context?.detected_window || 0);
        const mode = getRoutingMode(config.context?.detected_window || 32768, process.env.SMALLCODE_TOOL_ROUTING);
        console.log(chalk.bold('  Model Profile'));
        console.log(`  Model:     ${chalk.cyan(config.model.name)}`);
        console.log(`  Matched:   ${profile.matched_key ? chalk.green(profile.matched_key) : chalk.gray('none (using defaults)')}`);
        console.log(`  Context:   ${chalk.white(String(profile.context_length))} tokens`);
        console.log(`  Max out:   ${chalk.white(String(profile.max_output))} tokens`);
        console.log(`  Tools:     ${chalk.white(profile.tool_format)}`);
        console.log(`  Routing:   ${chalk.white(mode)}`);
        if (profile.strengths.length) console.log(`  Strengths: ${chalk.green(profile.strengths.join(', '))}`);
        if (profile.weaknesses.length) console.log(`  Weak:      ${chalk.yellow(profile.weaknesses.join(', '))}`);
        console.log('');
        rl.prompt();
        return;
      }

      case '/cognition': {
        // Phase A-D: Show MarrowScript-compiled cognition layer status
        let cognition = null;
        try { cognition = require('../src/compiled/cognition'); } catch {}
        if (!cognition) {
          console.log(chalk.gray('  Cognition layer: not loaded'));
          console.log(chalk.gray('  (compile marrow/smallcode_cognition.marrow → src/compiled/)'));
          console.log('');
          rl.prompt();
          return;
        }
        console.log(chalk.bold('  MarrowScript Cognition Layer'));
        console.log(`  Status:    ${chalk.green('● loaded')}`);
        try {
          const models = cognition.listModelNames ? cognition.listModelNames() : [];
          console.log(`  Models:    ${chalk.cyan(models.join(', ') || '(none)')}`);
        } catch {}
        try {
          const prompts = Object.keys(cognition.PROMPTS || {});
          console.log(`  Prompts:   ${chalk.cyan(prompts.join(', ') || '(none)')}`);
        } catch {}
        try {
          const routers = Object.keys(cognition.ROUTERS || {});
          console.log(`  Routers:   ${chalk.cyan(routers.join(', ') || '(none)')}`);
        } catch {}
        console.log(`  Logs:      ${process.env.SMALLCODE_COGNITION_LOG ? chalk.green('on (' + process.env.SMALLCODE_COGNITION_LOG + ')') : chalk.gray('off (set SMALLCODE_COGNITION_LOG=stdout to enable)')}`);
        console.log(chalk.gray('  Source:    marrow/smallcode_cognition.marrow'));
        console.log('');
        rl.prompt();
        return;
      }

      case '/mcp': {
        const { MCPClient } = require('../src/tools/mcp_client');
        const client = new MCPClient(process.cwd());
        const serverCount = client.loadConfig();
        if (serverCount === 0) {
          console.log(chalk.gray('  No MCP servers configured.'));
          console.log(chalk.gray('  Add .smallcode/mcp.json to connect external tools.'));
          console.log(chalk.gray('  Example: { "mcpServers": { "github": { "command": "uvx", "args": ["mcp-server-github"] } } }'));
        } else {
          // Check if global mcpClient is connected
          if (typeof mcpClient !== 'undefined' && mcpClient) {
            const status = mcpClient.status();
            console.log(chalk.bold(`  MCP Servers (${status.length}):`));
            for (const s of status) {
              const state = s.connected ? chalk.green('● connected') : chalk.red('○ disconnected');
              console.log(`    ${state} ${chalk.cyan(s.name)} (${s.command})`);
              if (s.tools.length) console.log(`      Tools: ${s.tools.join(', ')}`);
            }
          } else {
            console.log(chalk.gray(`  ${serverCount} server(s) configured but not yet connected.`));
            console.log(chalk.gray('  They connect automatically on first tool use.'));
          }
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/skill': {
        const { SkillManager } = require('../src/plugins/skills');
        const sm = new SkillManager(process.cwd());
        const sub = parts[1];

        if (!sub || sub === 'list') {
          const skills = sm.list();
          if (skills.length === 0) {
            console.log(chalk.gray('  No skills defined.'));
            console.log(chalk.gray('  Create one: /skill add <name>'));
            console.log(chalk.gray('  Skills teach the model reusable behaviors.'));
          } else {
            console.log(chalk.bold(`  Skills (${skills.length}):`));
            for (const s of skills) {
              const trigger = s.trigger === 'auto' ? chalk.green('auto') : s.trigger === 'match' ? chalk.yellow('match') : chalk.gray('manual');
              console.log(`    ${chalk.cyan(s.name)} [${trigger}] ${chalk.gray(s.preview)}`);
            }
          }
        } else if (sub === 'use') {
          const name = parts[2];
          if (!name) { console.log(chalk.gray('  Usage: /skill use <name>')); }
          else {
            const skill = sm.get(name);
            if (!skill) { console.log(chalk.red(`  Skill "${name}" not found.`)); }
            else {
              // Inject into conversation as a system message
              conversationHistory.push({ role: 'system', content: `[Skill: ${skill.name}]\n${skill.content}` });
              console.log(chalk.green(`  ✓ Skill "${skill.name}" activated for this conversation.`));
            }
          }
        } else if (sub === 'add') {
          const name = parts[2];
          if (!name) { console.log(chalk.gray('  Usage: /skill add <name>')); }
          else {
            const content = parts.slice(3).join(' ') || 'Describe the skill behavior here.';
            const skill = sm.add(name, content, { trigger: 'manual' });
            console.log(chalk.green(`  ✓ Created skill "${name}" at ${skill.path}`));
            console.log(chalk.gray('  Edit the .md file to customize the skill content.'));
          }
        } else if (sub === 'remove') {
          const name = parts[2];
          if (!name) { console.log(chalk.gray('  Usage: /skill remove <name>')); }
          else {
            const ok = sm.remove(name);
            console.log(ok ? chalk.green(`  ✓ Removed "${name}"`) : chalk.red(`  Skill "${name}" not found.`));
          }
        } else {
          console.log(chalk.gray('  /skill list          Show all skills'));
          console.log(chalk.gray('  /skill use <name>    Activate a skill'));
          console.log(chalk.gray('  /skill add <name>    Create a new skill'));
          console.log(chalk.gray('  /skill remove <name> Delete a skill'));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/plugin': {
        const { PluginLoader } = require('../src/plugins/loader');
        const pl = new PluginLoader(process.cwd()).loadAll();
        const sub = parts[1];

        if (!sub || sub === 'list') {
          const plugins = pl.list();
          if (plugins.length === 0) {
            console.log(chalk.gray('  No plugins installed.'));
            console.log(chalk.gray('  Install: /plugin install <npm-package-or-github-url>'));
          } else {
            console.log(chalk.bold(`  Plugins (${plugins.length}):`));
            for (const p of plugins) {
              console.log(`    ${chalk.cyan(p.name)} v${p.version} — ${chalk.gray(p.description)}`);
              if (p.tools.length) console.log(`      Tools: ${p.tools.join(', ')}`);
              if (p.commands.length) console.log(`      Commands: ${p.commands.join(', ')}`);
            }
          }
        } else if (sub === 'install') {
          const pkg = parts[2];
          if (!pkg) {
            console.log(chalk.gray('  Usage: /plugin install <npm-package-or-github-url>'));
            console.log(chalk.gray('  Example: /plugin install smallcode-plugin-lint'));
            console.log(chalk.gray('  Example: /plugin install github:user/repo'));
          } else {
            const { execFileSync } = require('child_process');
            const pluginsDir = require('path').join(process.cwd(), '.smallcode', 'plugins');
            const fs = require('fs');
            if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
            // Validate package name — only allow npm-safe characters to prevent injection.
            // Legitimate names: @scope/pkg, pkg-name, github:user/repo
            if (!/^[@a-zA-Z0-9._\-/: ]+$/.test(pkg)) {
              console.log(chalk.red(`  ✗ Invalid package name: ${pkg}`));
            } else {
              console.log(chalk.gray(`  Installing ${pkg}...`));
              try {
                execFileSync('npm', ['install', '--prefix', pluginsDir, pkg], { encoding: 'utf-8', timeout: 60000, cwd: process.cwd() });
                console.log(chalk.green(`  ✓ Installed ${pkg}`));
                console.log(chalk.gray('  Restart SmallCode to activate.'));
              } catch (e) {
                console.log(chalk.red(`  ✗ Install failed: ${((e.stderr || '') + (e.message || '')).slice(0, 200)}`));
              }
            }
          }
        } else if (sub === 'remove') {
          const pkg = parts[2];
          if (!pkg) {
            console.log(chalk.gray('  Usage: /plugin remove <name>'));
          } else {
            const pluginDir = require('path').join(process.cwd(), '.smallcode', 'plugins', pkg);
            const fs = require('fs');
            if (fs.existsSync(pluginDir)) {
              fs.rmSync(pluginDir, { recursive: true });
              console.log(chalk.green(`  ✓ Removed ${pkg}`));
            } else {
              console.log(chalk.red(`  Plugin "${pkg}" not found in .smallcode/plugins/`));
            }
          }
        } else {
          console.log(chalk.gray('  /plugin list              Show installed plugins'));
          console.log(chalk.gray('  /plugin install <pkg>     Install from npm/github'));
          console.log(chalk.gray('  /plugin remove <name>     Remove a plugin'));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/undo': {
        const sub = parts[1];
        if (sub === 'list') {
          const edits = (global._smallcodeUndo || { list: () => [] }).list(10);
          if (edits.length === 0) {
            console.log(chalk.gray('  No edits to undo.'));
          } else {
            console.log(chalk.bold('  Recent edits:'));
            for (const e of edits) {
              console.log(`    ${chalk.cyan(`#${e.id}`)} ${chalk.white(e.path)} ${chalk.gray(`(${e.type}, ${e.age}s ago)`)}`);
            }
            console.log(chalk.gray('\n  /undo       Revert last edit'));
            console.log(chalk.gray('  /undo <id>  Revert specific edit'));
            console.log(chalk.gray('  /undo all   Git revert all changes'));
          }
        } else if (sub === 'all') {
          const { execSync } = require('child_process');
          try {
            execSync('git checkout -- .', { encoding: 'utf-8', cwd: process.cwd() });
            console.log(`  ${chalk.green('✓')} Reverted all uncommitted changes.`);
          } catch {
            console.log(chalk.red('  Not a git repo.'));
          }
        } else if (sub && !isNaN(sub)) {
          const result = (global._smallcodeUndo || { undoById: () => null }).undoById(parseInt(sub));
          if (result && !result.error) {
            console.log(`  ${chalk.green('✓')} Reverted ${result.reverted}: ${result.action}`);
          } else {
            console.log(chalk.red(`  ${result?.error || 'Edit not found.'}`));
          }
        } else {
          const result = (global._smallcodeUndo || { undoLast: () => null }).undoLast();
          if (result && !result.error) {
            console.log(`  ${chalk.green('✓')} Reverted ${result.reverted}: ${result.action}`);
          } else if (result?.error) {
            console.log(chalk.red(`  ${result.error}`));
          } else {
            console.log(chalk.gray('  No edits to undo. Use /undo all for git revert.'));
          }
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/share': {
        const { exportToMarkdown, exportToGist } = require('../src/session/share');
        const sub = parts[1];
        if (conversationHistory.length === 0) {
          console.log(chalk.gray('  No session to share.'));
        } else if (sub === 'gist') {
          console.log(chalk.gray('  Creating gist...'));
          const session = { id: 'tmp', title: conversationHistory.find(m => m.role === 'user')?.content?.slice(0, 40) || '', messages: conversationHistory, model: config.model.name, createdAt: new Date().toISOString() };
          const result = exportToGist(session);
          if (result.success) {
            console.log(`  ${chalk.green('✓')} Shared: ${chalk.cyan(result.url)}`);
          } else {
            console.log(chalk.red(`  Failed: ${result.error}`));
          }
        } else {
          const outputPath = sub || `smallcode-session-${Date.now()}.md`;
          const session = { id: 'tmp', title: '', messages: conversationHistory, model: config.model.name, createdAt: new Date().toISOString() };
          exportToMarkdown(session, outputPath);
          console.log(`  ${chalk.green('✓')} Exported to ${chalk.cyan(outputPath)}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/files': {
        const { execSync } = require('child_process');
        try {
          const output = execSync('git ls-files', { encoding: 'utf-8', cwd: process.cwd() });
          const files = output.trim().split('\n');
          console.log(chalk.bold(`  Project files (${files.length}):`));
          for (const f of files.slice(0, 30)) {
            console.log(chalk.gray(`    ${f}`));
          }
          if (files.length > 30) console.log(chalk.gray(`    ... (${files.length - 30} more)`));
        } catch {
          const entries = fs.readdirSync(process.cwd()).slice(0, 20);
          for (const e of entries) console.log(chalk.gray(`    ${e}`));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/session': {
        const { MultiSessionManager } = require('../src/session/multi');
        if (!global._smallcodeMulti) global._smallcodeMulti = new MultiSessionManager();
        const msm = global._smallcodeMulti;
        const sub = parts[1];

        if (!sub || sub === 'list') {
          const sessions = msm.list();
          if (sessions.length === 0) {
            console.log(chalk.gray('  No parallel sessions. Use /session new <task>'));
          } else {
            console.log(chalk.bold(`  Parallel sessions (${sessions.length}):`));
            for (const s of sessions) {
              const marker = s.active ? chalk.green(' ●') : '  ';
              console.log(`  ${marker} ${chalk.cyan(s.id)} ${chalk.white(s.title)} ${chalk.gray(`${s.messages} msgs, ${s.age}s`)}`);
            }
          }
        } else if (sub === 'new') {
          const title = parts.slice(2).join(' ') || undefined;
          const s = msm.create(title);
          conversationHistory.length = 0; // Clear current for new session
          console.log(`  ${chalk.green('✓')} New session ${chalk.cyan(s.id)}: ${s.title}`);
        } else if (sub === 'switch') {
          const id = parts[2];
          if (!id) { console.log(chalk.gray('  Usage: /session switch <id>')); }
          else {
            const s = msm.switch(id);
            if (s) {
              conversationHistory.length = 0;
              conversationHistory.push(...s.messages);
              console.log(`  ${chalk.green('✓')} Switched to ${chalk.cyan(s.id)}: ${s.title}`);
            } else {
              console.log(chalk.red(`  Session ${id} not found.`));
            }
          }
        } else if (sub === 'kill') {
          const id = parts[2];
          if (!id) { console.log(chalk.gray('  Usage: /session kill <id>')); }
          else {
            const ok = msm.kill(id);
            console.log(ok ? chalk.green(`  ✓ Killed ${id}`) : chalk.red(`  Not found: ${id}`));
          }
        } else {
          console.log(chalk.gray('  /session list          Show parallel sessions'));
          console.log(chalk.gray('  /session new <task>    Start new session'));
          console.log(chalk.gray('  /session switch <id>   Switch focus'));
          console.log(chalk.gray('  /session kill <id>     Terminate session'));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/sessions': {
        const { SessionStore } = require('../src/session/persistence');
        const ss = new SessionStore(process.cwd());
        const sub = parts[1];
        const sessions = ss.list();

        if (sub === 'resume' || sub === 'load') {
          const id = parts[2];
          if (!id) {
            console.log(chalk.gray('  Usage: /sessions resume <id>'));
          } else {
            const loaded = ss.load(id);
            if (loaded) {
              conversationHistory.length = 0;
              conversationHistory.push(...loaded.messages);
              console.log(chalk.green(`  ✓ Resumed "${loaded.title || 'untitled'}" (${loaded.messages.length} msgs)`));
            } else {
              console.log(chalk.red(`  Session ${id} not found.`));
            }
          }
        } else {
          if (sessions.length === 0) {
            console.log(chalk.gray('  No saved sessions.'));
          } else {
            console.log(chalk.bold(`  Sessions (${sessions.length}):`));
            for (const s of sessions.slice(0, 15)) {
              const age = Math.floor((Date.now() - new Date(s.updatedAt).getTime()) / 60000);
              const ageStr = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.floor(age/60)}h ago` : `${Math.floor(age/1440)}d ago`;
              console.log(`    ${chalk.cyan(s.id.slice(0, 8))} ${chalk.white(s.title || 'untitled')} ${chalk.gray(`${s.msgs} msgs · ${ageStr}`)}`);
            }
            console.log(chalk.gray('\n  Resume: /sessions resume <id>'));
          }
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/version':
      case '/v': {
        // Read version from package.json (single source of truth).
        try {
          const pkg = require('../package.json');
          console.log('');
          console.log(`  ${chalk.bold('SmallCode')} ${chalk.cyan('v' + pkg.version)}`);
          if (pkg.description) console.log(`  ${chalk.gray(pkg.description)}`);
          console.log(`  ${chalk.gray('Node ' + process.version + ' on ' + process.platform + '/' + process.arch)}`);
          console.log('');
        } catch (e) {
          console.log(chalk.gray('  Version info unavailable: ' + e.message));
          console.log('');
        }
        rl.prompt();
        return;
      }

      case '/contract': {
        const { getStore } = require('../src/session/contract_store');
        const { formatStatus, statusPayload } = require('../src/session/contract_tools');
        const store = getStore(process.cwd());
        const sub = parts[1];

        if (!sub || sub === 'status') {
          const payload = statusPayload(store);
          console.log('');
          console.log(formatStatus(payload));
          console.log('');
        } else if (sub === 'list') {
          const all = store.list();
          if (all.length === 0) {
            console.log(chalk.gray('  No contracts. Use /contract create <title>...'));
          } else {
            const activeId = store.activeId();
            for (const row of all) {
              const marker = row.id === activeId ? chalk.green('●') : ' ';
              const ds = row.doneStatus;
              console.log(`  ${marker} ${chalk.cyan(row.id)}  [${row.status}]  ${row.title}  ${chalk.gray(`(${ds.passed}/${ds.total})`)}`);
            }
          }
          console.log('');
        } else if (sub === 'activate') {
          const id = parts[2];
          if (!id) { console.log(chalk.gray('  Usage: /contract activate <id>')); }
          else {
            try { store.activate(id); console.log(chalk.green(`  ✓ Activated ${id}`)); }
            catch (e) { console.log(chalk.red(`  ${e.message}`)); }
          }
          console.log('');
        } else if (sub === 'deactivate') {
          store.deactivate();
          console.log(chalk.gray('  Active contract cleared.'));
          console.log('');
        } else if (sub === 'abort') {
          const reason = parts.slice(2).join(' ') || '';
          try { const c = store.abort(reason); console.log(chalk.yellow(`  ⊘ Aborted ${c.id}`)); }
          catch (e) { console.log(chalk.red(`  ${e.message}`)); }
          console.log('');
        } else {
          console.log(chalk.gray('  /contract                Show active contract status'));
          console.log(chalk.gray('  /contract list           List all contracts'));
          console.log(chalk.gray('  /contract activate <id>  Switch active contract'));
          console.log(chalk.gray('  /contract deactivate     Clear active contract'));
          console.log(chalk.gray('  /contract abort <reason> Abort the active contract'));
          console.log(chalk.gray(''));
          console.log(chalk.gray('  Note: contracts are normally created by the agent via the'));
          console.log(chalk.gray('        contract_create tool. The model can\'t deliver "done"'));
          console.log(chalk.gray('        while any assertion is pending or failed.'));
          console.log('');
        }
        rl.prompt();
        return;
      }

      case '/help':
        console.log('');
        console.log(chalk.bold('  Commands'));
        console.log(chalk.gray('  ─────────────────────────────────────'));
        console.log(`  ${chalk.cyan('/model')} <name>  ${chalk.gray('Switch model mid-session')}`);
        console.log(`  ${chalk.cyan('/endpoint')} <u>  ${chalk.gray('Switch API endpoint')}`);
        console.log(`  ${chalk.cyan('/stats')}         ${chalk.gray('Model, history, cwd')}`);
        console.log(`  ${chalk.cyan('/files')}         ${chalk.gray('List project files')}`);
        console.log(`  ${chalk.cyan('/diff')}          ${chalk.gray('Git diff summary')}`);
        console.log(`  ${chalk.cyan('/git')} <cmd>     ${chalk.gray('Run any git command')}`);
        console.log(`  ${chalk.cyan('/loop')} <file>   ${chalk.gray('Validate + auto-fix')}`);
        console.log(`  ${chalk.cyan('/memory')}        ${chalk.gray('View/manage project memory')}`);
        console.log(`  ${chalk.cyan('/contract')}      ${chalk.gray('Definition-of-Done contract')}`);
        console.log(`  ${chalk.cyan('/undo')}          ${chalk.gray('Revert uncommitted changes')}`);
        console.log(`  ${chalk.cyan('/compact')}       ${chalk.gray('Trim conversation history')}`);
        console.log(`  ${chalk.cyan('/escalation')}    ${chalk.gray('View model escalation status')}`);
        console.log(`  ${chalk.cyan('/profile')}       ${chalk.gray('Show detected model profile')}`);
        console.log(`  ${chalk.cyan('/cognition')}     ${chalk.gray('Show MarrowScript cognition layer status')}`);
        console.log(`  ${chalk.cyan('/tokens')}        ${chalk.gray('Detailed token usage report')}`);
        console.log(`  ${chalk.cyan('/budget')}        ${chalk.gray('Show context window budget')}`);
        console.log(`  ${chalk.cyan('/mcp')}           ${chalk.gray('Show connected MCP servers')}`);
        console.log(`  ${chalk.cyan('/skill')}         ${chalk.gray('Manage reusable skills')}`);
        console.log(`  ${chalk.cyan('/plugin')}        ${chalk.gray('List installed plugins')}`);
        console.log(`  ${chalk.cyan('/sessions')}      ${chalk.gray('List/resume saved sessions')}`);
        console.log(`  ${chalk.cyan('/trace')}         ${chalk.gray('View/export execution traces')}`);
        console.log(`  ${chalk.cyan('/eval')} <suite>   ${chalk.gray('Run prompt evaluation')}`);
        console.log(`  ${chalk.cyan('/clear')}         ${chalk.gray('Reset entire session')}`);
        console.log(`  ${chalk.cyan('/version')}       ${chalk.gray('Show SmallCode version')}`);
        console.log(`  ${chalk.cyan('/quit')}          ${chalk.gray('Exit SmallCode')}`);
        console.log('');
        rl.prompt();
        return;

      default: {
        // Try plugin commands before showing "unknown"
        const { PluginLoader } = require('../src/plugins/loader');
        const pl = new PluginLoader(process.cwd()).loadAll();
        if (pl.commands[parts[0]]) {
          const result = await pl.executeCommand(parts[0], parts.slice(1).join(' '), { config, conversationHistory });
          if (result) console.log(result);
        } else {
          console.log(chalk.gray(`  Unknown: ${parts[0]}. Type /help`));
        }
        console.log('');
        rl.prompt();
        return;
      }
    }
  };
};
