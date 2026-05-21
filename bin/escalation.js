// SmallCode — Model Escalation Engine
// When local model hard fails AND decompose fails, escalate to a stronger model
// (Claude, OpenAI, etc.) if the user has configured an API key.
//
// This is opt-in: users must configure [escalation] in smallcode.toml
// or set environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY).

const fs = require('fs');
const path = require('path');

// ─── Escalation Config ───────────────────────────────────────────────────────

const ESCALATION_PROVIDERS = {
  anthropic: {
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.4-mini',
    models: ['gpt-5.4-mini', 'gpt-5.4-nano'],
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4',
    models: ['deepseek-v4', 'deepseek-v4-pro', 'deepseek-v4-flash'],
  },
};

class EscalationEngine {
  constructor(config = {}) {
    this.enabled = false;
    this.provider = null;
    this.apiKey = null;
    this.model = null;
    this.baseUrl = null;
    this.maxEscalationsPerSession = config.max_per_session || 5;
    this.escalationCount = 0;
    this.confirmBeforeEscalate = config.confirm !== false; // default: ask user

    this._detectConfig(config);
  }

  // Auto-detect available escalation providers from config or env
  _detectConfig(config) {
    // Check explicit config first
    if (config.provider && config.api_key) {
      const providerInfo = ESCALATION_PROVIDERS[config.provider];
      if (providerInfo) {
        this.enabled = true;
        this.provider = config.provider;
        this.apiKey = config.api_key;
        this.model = config.model || providerInfo.defaultModel;
        this.baseUrl = config.base_url || providerInfo.baseUrl;
        return;
      }
    }

    // Fall back to environment variables (check in preference order)
    const order = ['anthropic', 'openai', 'deepseek'];
    for (const provName of order) {
      const prov = ESCALATION_PROVIDERS[provName];
      const key = process.env[prov.envKey];
      if (key) {
        this.enabled = true;
        this.provider = provName;
        this.apiKey = key;
        this.model = config.model || prov.defaultModel;
        this.baseUrl = config.base_url || prov.baseUrl;
        return;
      }
    }

    // Not configured — escalation disabled
    this.enabled = false;
  }

  // Check if escalation is available and hasn't exceeded session limit
  canEscalate() {
    return this.enabled && this.escalationCount < this.maxEscalationsPerSession;
  }

  // Get status string for TUI
  status() {
    if (!this.enabled) return 'disabled (no API key configured)';
    const prov = ESCALATION_PROVIDERS[this.provider];
    return `${prov.name} (${this.model}) — ${this.escalationCount}/${this.maxEscalationsPerSession} used`;
  }

  // Escalate a failed task to the stronger model
  // Returns the model's response or null on failure
  async escalate(messages, tools, systemPromptExtra = '') {
    if (!this.canEscalate()) return null;

    this.escalationCount++;

    const systemMsg = {
      role: 'system',
      content: `You are an expert coding assistant called in as escalation support.
A smaller local model attempted this task but failed after multiple retry and decompose attempts.
Your job: solve it correctly in as few tool calls as possible.
Be precise. Don't explain unnecessarily. Just fix it.
${systemPromptExtra}`,
    };

    // Plugin-registered providers: use the registry
    const { providerRegistry } = require('../src/compiled/providers/registry');
    const pluginProvider = providerRegistry.get(this.provider);
    if (pluginProvider) {
      try {
        return await pluginProvider.chat({
          model: this.model,
          messages: [systemMsg, ...messages],
          temperature: 0.1,
          maxOutput: 4096,
          tools: tools || [],
        });
      } catch (err) {
        return { error: `Plugin provider "${this.provider}" failed: ${err.message}` };
      }
    }

    if (this.provider === 'anthropic') {
      return this._callAnthropic([systemMsg, ...messages], tools);
    } else {
      return this._callOpenAICompat([systemMsg, ...messages], tools);
    }
  }

  // OpenAI-compatible endpoint (works for OpenAI + DeepSeek)
  async _callOpenAICompat(messages, tools) {
    try {
      const body = {
        model: this.model,
        messages,
        temperature: 0.1,
        max_tokens: 4096,
      };
      if (tools && tools.length > 0) {
        body.tools = tools;
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.text();
        return { error: `Escalation API error ${response.status}: ${err.slice(0, 200)}` };
      }

      const data = await response.json();
      return data.choices?.[0]?.message || null;
    } catch (err) {
      return { error: `Escalation failed: ${err.message}` };
    }
  }

  // Anthropic Messages API
  async _callAnthropic(messages, tools) {
    try {
      // Convert from OpenAI format to Anthropic format
      const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      const nonSystem = messages.filter(m => m.role !== 'system');

      // Convert tool results from OpenAI format
      const rawMessages = nonSystem.map(m => {
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
          };
        }
        if (m.tool_calls) {
          return {
            role: 'assistant',
            content: m.tool_calls.map(tc => {
              let inputArgs = {};
              try { inputArgs = JSON.parse(tc.function.arguments || '{}'); } catch { inputArgs = {}; }
              return {
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: inputArgs,
              };
            }),
          };
        }
        return { role: m.role, content: m.content };
      });

      // Fix #10: Anthropic requires alternating user/assistant. Merge consecutive
      // same-role messages (common when SmallCode injects [AUTO-FIX], [SYSTEM],
      // [DECOMPOSE] etc. as role:'user' back-to-back).
      const anthropicMessages = [];
      for (const msg of rawMessages) {
        if (anthropicMessages.length > 0 && anthropicMessages[anthropicMessages.length - 1].role === msg.role) {
          // Merge into previous message
          const prev = anthropicMessages[anthropicMessages.length - 1];
          if (typeof prev.content === 'string' && typeof msg.content === 'string') {
            prev.content = prev.content + '\n\n' + msg.content;
          } else if (Array.isArray(prev.content) && Array.isArray(msg.content)) {
            prev.content = [...prev.content, ...msg.content];
          } else if (typeof prev.content === 'string' && Array.isArray(msg.content)) {
            prev.content = [{ type: 'text', text: prev.content }, ...msg.content];
          } else if (Array.isArray(prev.content) && typeof msg.content === 'string') {
            prev.content = [...prev.content, { type: 'text', text: msg.content }];
          }
        } else {
          anthropicMessages.push({ ...msg });
        }
      }

      // Ensure first message is from user (Anthropic requirement)
      if (anthropicMessages.length > 0 && anthropicMessages[0].role !== 'user') {
        anthropicMessages.unshift({ role: 'user', content: '(continuing from earlier context)' });
      }

      // Convert tools to Anthropic format
      const anthropicTools = (tools || []).map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));

      const body = {
        model: this.model,
        max_tokens: 4096,
        system,
        messages: anthropicMessages,
      };
      if (anthropicTools.length > 0) {
        body.tools = anthropicTools;
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.text();
        return { error: `Anthropic error ${response.status}: ${err.slice(0, 200)}` };
      }

      const data = await response.json();

      // Convert Anthropic response back to OpenAI format for uniform handling
      const content = data.content || [];
      const textBlocks = content.filter(b => b.type === 'text');
      const toolBlocks = content.filter(b => b.type === 'tool_use');

      if (toolBlocks.length > 0) {
        return {
          role: 'assistant',
          content: textBlocks.map(b => b.text).join('') || null,
          tool_calls: toolBlocks.map(b => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })),
        };
      }

      return {
        role: 'assistant',
        content: textBlocks.map(b => b.text).join('') || '',
      };
    } catch (err) {
      return { error: `Anthropic escalation failed: ${err.message}` };
    }
  }
}

module.exports = { EscalationEngine, ESCALATION_PROVIDERS };
