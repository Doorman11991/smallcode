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
//   "hooks": [{ "event": "pre_request|post_request|on_error|session_start|session_end|post_tool", "filter": ["write_file"], "handler": "./hook.js" }],
//   "init": "./init.js",
//   "shutdown": "./cleanup.js",
//   "providers": [{ "name": "...", "module": "./adapter.js", "options": {}, "capabilities": { "tools": true, "streaming": true } }],
//   "permissions": { "read": true, "write": true, "execute": false, "network": true },
//   "mcpServers": { "my-server": { "command": "./server.js", "args": [], "transport": "stdio" } }
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
    this.initHandlers = [];   // async init handlers from plugin manifests
    this.shutdownHandlers = []; // async shutdown handlers from plugin manifests
    this.permissions = {};   // plugin name → { read, write, execute, network }
    this.mcpServers = {};    // plugin name → { serverName: { command, args, transport } }
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
        const validEvents = ['pre_tool', 'post_tool', 'session_start', 'session_end',
                             'pre_request', 'post_request', 'on_error'];
        for (const h of manifest.hooks) {
          if (!validEvents.includes(h.event)) {
            console.warn(`[plugin:${plugin.name}] Unknown hook event "${h.event}", skipping`);
            continue;
          }
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

      // Register init handler
      if (manifest.init) {
        const initPath = path.resolve(pluginDir, manifest.init);
        if (fs.existsSync(initPath)) {
          try {
            const initHandler = require(initPath);
            this.initHandlers.push({
              handler: initHandler.default || initHandler,
              plugin: plugin.name,
            });
          } catch (e) {
            console.error(`[plugin:${plugin.name}] Failed to load init: ${e.message}`);
          }
        }
      }

      // Register shutdown handler
      if (manifest.shutdown) {
        const shutdownPath = path.resolve(pluginDir, manifest.shutdown);
        if (fs.existsSync(shutdownPath)) {
          try {
            const shutdownHandler = require(shutdownPath);
            this.shutdownHandlers.push({
              handler: shutdownHandler.default || shutdownHandler,
              plugin: plugin.name,
            });
          } catch (e) {
            console.error(`[plugin:${plugin.name}] Failed to load shutdown: ${e.message}`);
          }
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

      // Register permissions
      if (manifest.permissions) {
        this.permissions[plugin.name] = {
          read: !!manifest.permissions.read,
          write: !!manifest.permissions.write,
          execute: !!manifest.permissions.execute,
          network: !!manifest.permissions.network,
        };
      } else {
        // Default: read-only, no write/execute/network
        this.permissions[plugin.name] = { read: true, write: false, execute: false, network: false };
      }

      // Register MCP server declarations
      if (manifest.mcpServers) {
        this.mcpServers[plugin.name] = {};
        for (const [serverName, serverDef] of Object.entries(manifest.mcpServers)) {
          this.mcpServers[plugin.name][serverName] = {
            command: serverDef.command,
            args: serverDef.args || [],
            transport: serverDef.transport || 'stdio',
          };
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

  // Get permissions for a plugin
  getPermissions(pluginName) {
    return this.permissions[pluginName] || null;
  }

  // Check if a plugin has a specific permission
  hasPermission(pluginName, perm) {
    const p = this.permissions[pluginName];
    return p ? !!p[perm] : false;
  }

  // Get all MCP server declarations across plugins
  getMCPServers() {
    const servers = {};
    for (const [plugin, pluginServers] of Object.entries(this.mcpServers)) {
      for (const [name, def] of Object.entries(pluginServers)) {
        servers[`${plugin}/${name}`] = def;
      }
    }
    return servers;
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

  // Run all plugin init handlers. Called once at startup after loadAll().
  async runInit(context = {}) {
    for (const { handler, plugin } of this.initHandlers) {
      try {
        await handler(context);
      } catch (e) {
        console.error(`[plugin:${plugin}] init failed: ${e.message}`);
      }
    }
  }

  // Run all plugin shutdown handlers. Called on exit for cleanup.
  async runShutdown(context = {}) {
    for (const { handler, plugin } of this.shutdownHandlers) {
      try {
        await handler(context);
      } catch (e) {
        console.error(`[plugin:${plugin}] shutdown failed: ${e.message}`);
      }
    }
  }

  // Execute hooks for a given event. Returns array of results from non-void handlers.
  async runHooks(event, data = {}) {
    const results = [];
    for (const hook of this.hooks) {
      if (hook.event !== event) continue;
      if (hook.filter.length > 0 && !hook.filter.includes(data.toolName || '')) continue;
      if (!hook.handler) continue;

      // For post_tool hooks, handler is { after(toolResult, ctx) }
      // For new event hooks, handler is { handle(data) } or a plain function
      try {
        if (hook.handler.handle) {
          const result = await hook.handler.handle(data);
          if (result !== undefined) results.push(result);
        } else if (typeof hook.handler === 'function') {
          const result = await hook.handler(data);
          if (result !== undefined) results.push(result);
        }
      } catch (e) {
        console.error(`[plugin:${plugin}] hook ${event} failed: ${e.message}`);
      }
    }
    return results;
  }
}

module.exports = { PluginLoader };
