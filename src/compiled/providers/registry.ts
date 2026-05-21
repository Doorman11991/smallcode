// Plugin-provider registry.
// Plugins register named providers at load time; the runtime resolves them
// by name via resolveProvider() in index.ts.  If no plugin provider is
// registered, the default OpenAI-compatible adapter is used.

import type { IModelProvider } from "./types";

export interface ProviderCapabilities {
  tools: boolean;
  streaming: boolean;
  vision: boolean;
  tokenCounting: "exact" | "heuristic" | "none";
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  tools: true,
  streaming: true,
  vision: false,
  tokenCounting: "heuristic",
};

class ProviderRegistry {
  private providers = new Map<string, IModelProvider>();
  private capabilities = new Map<string, ProviderCapabilities>();

  register(
    name: string,
    provider: IModelProvider,
    caps?: Partial<ProviderCapabilities>,
  ): void {
    this.providers.set(name, provider);
    this.capabilities.set(name, { ...DEFAULT_CAPABILITIES, ...caps });
  }

  get(name: string): IModelProvider | undefined {
    return this.providers.get(name);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  getCapabilities(name: string): ProviderCapabilities {
    return this.capabilities.get(name) ?? DEFAULT_CAPABILITIES;
  }
}

export const providerRegistry = new ProviderRegistry();
