"use strict";
// Plugin-provider registry.
// Plugins register named providers at load time; the runtime resolves them
// by name via resolveProvider() in index.ts.  If no plugin provider is
// registered, the default OpenAI-compatible adapter is used.
Object.defineProperty(exports, "__esModule", { value: true });
exports.providerRegistry = exports.ProviderRegistry = void 0;

const DEFAULT_CAPABILITIES = {
  tools: true,
  streaming: true,
  vision: false,
  tokenCounting: "heuristic",
};

class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.capabilities = new Map();
  }

  register(name, provider, caps) {
    this.providers.set(name, provider);
    this.capabilities.set(name, { ...DEFAULT_CAPABILITIES, ...caps });
  }

  get(name) {
    return this.providers.get(name);
  }

  has(name) {
    return this.providers.has(name);
  }

  list() {
    return [...this.providers.keys()];
  }

  getCapabilities(name) {
    return this.capabilities.get(name) ?? DEFAULT_CAPABILITIES;
  }
}

exports.ProviderRegistry = ProviderRegistry;
exports.providerRegistry = new ProviderRegistry();
