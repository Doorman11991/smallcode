// SmallCode — Plugin System
// Plugins extend SmallCode with:
//   - New tools (custom tool definitions + executors)
//   - System prompt injections (always or conditional)
//   - Event hooks (pre/post tool, session start/end)
//   - Custom commands (/slash commands)
//
// Plugin locations:
//   .smallcode/plugins/   — project-level
//   ~/.config/smallcode/plugins/  — user-level (global)
//
// Plugin format: a directory with plugin.json manifest + JS files
//
// plugin.json schema:
// {
//   "name": "my-plugin",
//   "version": "1.0.0",
//   "description": "What this plugin does",
//   "tools": [{ "name": "...", "description": "...", "parameters": {...}, "handler": "./handler.js" }],
//   "prompts": [{ "inject": "always|backend|coding", "content": "..." }],
//   "commands": [{ "name": "/mycmd", "description": "...", "handler": "./cmd.js" }],
//   "hooks": [{ "event": "post_tool", "filter": ["write_file"], "handler": "./hook.js" }],
//   "providers": [{ "name": "...", "module": "./adapter.js", "options": {} }]
// }

const fs = require('fs');
const path = require('path');
const os = require('os');
const { providerRegistry } = require('../compiled/providers/registry');

class PluginLoader {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this.plugins = [];
    this.tools = [];        // Additional tool definitions
    this.commands = {};     // /command → handler
    this.prompts = [];      // System prompt injections
    this.hooks = [];        // Event hooks
    this.providers = {};    // name → IModelProvider instance
    this.errors = [];       // { dir, message } for diagnostics
  }

  // Load all plugins from project + user dirs
  loadAll() {
    const dirs = [
      path.join(this.projectDir, '.smallcode', 'plugins'),
      path.join(os.homedir(), '.config', 'smallcode', 'plugins'),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          this._loadPlugin(path.join(dir, entry.name));
        } else if (entry.name.endsWith('.json') && entry.name !== 'package.json') {
          // Single-file plugin (just a manifest with inline content)
          this._loadSingleFile(path.join(dir, entry.name));
        }
      }
    }

    return this;
  }

  _loadPlugin(pluginDir) {
    const manifestPath = path.join(pluginDir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) return;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const plugin = {
        name: manifest.name || path.basename(pluginDir),
        version: manifest.version || '0.0.0',
        description: manifest.description || '',
        dir: pluginDir,
      };

      // Register tools
      if (manifest.tools) {
        for (const toolDef of manifest.tools) {
          const handlerPath = path.resolve(pluginDir, toolDef.handler || './handler.js');
          let handler = null;
          if (fs.existsSync(handlerPath)) {
            try { handler = require(handlerPath); } catch {}
          }
          this.tools.push({
            type: 'function',
            function: {
              name: toolDef.name,
              description: toolDef.description || '',
              parameters: toolDef.parameters || { type: 'object', properties: {} },
            },
            _handler: handler,
            _plugin: plugin.name,
          });
        }
      }

      // Register commands
      if (manifest.commands) {
        for (const cmdDef of manifest.commands) {
          const handlerPath = path.resolve(pluginDir, cmdDef.handler || './cmd.js');
          let handler = null;
          if (fs.existsSync(handlerPath)) {
            try { handler = require(handlerPath); } catch {}
          }
          this.commands[cmdDef.name] = {
            description: cmdDef.description || '',
            handler,
            plugin: plugin.name,
          };
        }
      }

      // Register prompt injections
      if (manifest.prompts) {
        for (const p of manifest.prompts) {
          this.prompts.push({
            inject: p.inject || 'always',  // "always", "backend", "coding", "debugging"
            content: p.content || '',
            plugin: plugin.name,
          });
        }
      }

      // Register hooks
      if (manifest.hooks) {
        for (const h of manifest.hooks) {
          const handlerPath = path.resolve(pluginDir, h.handler || './hook.js');
          let handler = null;
          if (fs.existsSync(handlerPath)) {
            try { handler = require(handlerPath); } catch {}
          }
          this.hooks.push({
            event: h.event,
            filter: h.filter || [],
            handler,
            plugin: plugin.name,
          });
        }
      }

      // Register providers
      if (manifest.providers) {
        for (const spec of manifest.providers) {
          try {
            const modulePath = path.resolve(pluginDir, spec.module);
            const Export = require(modulePath);
            const ProviderClass = Export.default || Export;
            const instance = new ProviderClass(spec.options || {});
            if (!instance.chat || !instance.name) {
              throw new Error(`Provider "${spec.name}" must implement .chat() and .name`);
            }
            const caps = spec.capabilities || {};
            providerRegistry.register(spec.name, instance, caps);
            this.providers[spec.name] = instance;
          } catch (e) {
            const msg = `Failed to load provider "${spec.name}": ${e.message}`;
            console.error(`[plugin:${plugin.name}] ${msg}`);
            this.errors.push({ dir: pluginDir, message: msg });
          }
        }
      }

      this.plugins.push(plugin);
    } catch (e) {
      // Store error for diagnostics, but don't crash
      this.errors.push({ dir: pluginDir, message: e.message });
    }
  }

  _loadSingleFile(filePath) {
    try {
      const manifest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (manifest.prompts) {
        for (const p of manifest.prompts) {
          this.prompts.push({
            inject: p.inject || 'always',
            content: p.content || '',
            plugin: manifest.name || path.basename(filePath, '.json'),
          });
        }
      }
    } catch {}
  }

  // Get tools to add to the model's tool list
  getTools() {
    return this.tools.map(t => ({ type: t.type, function: t.function }));
  }

  // Get prompt injections for a given task type
  getPromptInjections(taskType) {
    return this.prompts
      .filter(p => p.inject === 'always' || p.inject === taskType)
      .map(p => p.content)
      .join('\n');
  }

  // Execute a plugin tool
  async executeTool(name, args) {
    const tool = this.tools.find(t => t.function.name === name);
    if (!tool || !tool._handler) return null;
    try {
      if (typeof tool._handler === 'function') {
        return await tool._handler(args);
      } else if (tool._handler.execute) {
        return await tool._handler.execute(args);
      }
    } catch (e) {
      return { error: `Plugin tool ${name} failed: ${e.message}` };
    }
    return null;
  }

  // Execute a plugin command
  async executeCommand(name, args, context) {
    const cmd = this.commands[name];
    if (!cmd || !cmd.handler) return null;
    try {
      if (typeof cmd.handler === 'function') {
        return await cmd.handler(args, context);
      } else if (cmd.handler.run) {
        return await cmd.handler.run(args, context);
      }
    } catch (e) {
      return `Error in plugin command: ${e.message}`;
    }
    return null;
  }

  // Get error diagnostics for failed plugin loads
  getErrors() {
    return this.errors;
  }

  // List all plugins for display
  list() {
    return this.plugins.map(p => ({
      name: p.name,
      version: p.version,
      description: p.description,
      tools: this.tools.filter(t => t._plugin === p.name).map(t => t.function.name),
      commands: Object.keys(this.commands).filter(k => this.commands[k].plugin === p.name),
    }));
  }
}

module.exports = { PluginLoader };
