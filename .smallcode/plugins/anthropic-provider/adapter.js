// Anthropic Claude adapter — implements IModelProvider for SmallCode plugins.
// Translates between SmallCode's ChatRequest/ChatResponse and the Anthropic Messages API.

class AnthropicAdapter {
  constructor(options = {}) {
    this.name = 'anthropic';
    this.apiKeyEnv = options.apiKeyEnv || 'ANTHROPIC_API_KEY';
    this.baseUrl = options.baseUrl || 'https://api.anthropic.com/v1';
    this.defaultModel = options.defaultModel || 'claude-sonnet-4-20250514';
    this._apiKey = null;
  }

  _getApiKey() {
    if (!this._apiKey) {
      this._apiKey = process.env[this.apiKeyEnv];
      if (!this._apiKey) {
        throw new Error(`Missing API key: set ${this.apiKeyEnv} environment variable`);
      }
    }
    return this._apiKey;
  }

  _toAnthropicMessages(req) {
    const systemMessages = [];
    const userMessages = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg.content);
      } else if (msg.role === 'user') {
        userMessages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const assistantMsg = { role: 'assistant', content: msg.content };
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          assistantMsg.content = [
            { type: 'text', text: msg.content || '' },
            ...msg.tool_calls.map(tc => ({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: JSON.parse(tc.arguments || '{}'),
            })),
          ];
        }
        userMessages.push(assistantMsg);
      } else if (msg.role === 'tool') {
        userMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          }],
        });
      }
    }

    return {
      system: systemMessages.join('\n') || undefined,
      messages: userMessages,
    };
  }

  _toAnthropicTools(tools) {
    if (!tools || tools.length === 0) return undefined;
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  async chat(req, signal) {
    const apiKey = this._getApiKey();
    const { system, messages } = this._toAnthropicMessages(req);

    const body = {
      model: req.model || this.defaultModel,
      messages,
      max_tokens: req.max_output || 4096,
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop) body.stop_sequences = req.stop;

    const anthropicTools = this._toAnthropicTools(req.tools);
    if (anthropicTools) {
      body.tools = anthropicTools;
      if (req.tool_choice) {
        body.tool_choice = req.tool_choice === 'auto'
          ? { type: 'auto' }
          : req.tool_choice === 'required'
            ? { type: 'any' }
            : { type: 'auto' };
      }
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();

    // Parse response content blocks
    let content = '';
    const toolCalls = [];

    for (const block of data.content || []) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    return {
      content,
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
      },
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      raw: data,
    };
  }

  countTokens(text) {
    if (!text) return 0;
    // Claude approximate: ~4 chars per token (close to BPE average)
    return Math.ceil(text.length / 4);
  }
}

module.exports = AnthropicAdapter;
