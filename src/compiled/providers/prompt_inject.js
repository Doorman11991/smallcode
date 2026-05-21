"use strict";
// prompt_inject — wraps any IModelProvider and injects content into system messages.
// Used by the prompt-inject plugin to add custom instructions, RAG context,
// or persona content to every LLM call without touching the core runtime.
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("./types");
class PromptInjectProvider {
    constructor(options) {
        this.name = "prompt_inject";
        this.innerInstance = null;
        this.innerName = options.inner;
        this.injections = options.injections || [];
    }
    getInner() {
        if (!this.innerInstance) {
            const { providerRegistry } = require("./registry");
            this.innerInstance = providerRegistry.get(this.innerName);
            if (!this.innerInstance) {
                throw new Error(`prompt_inject: inner provider "${this.innerName}" not found in registry`);
            }
        }
        return this.innerInstance;
    }
    countTokens(text) {
        return (0, types_1.approxTokens)(text);
    }
    async chat(req, signal) {
        const messages = req.messages.map(m => ({ ...m }));
        const injectedContent = this.injections.map(i => i.content).join("\n\n");
        const position = this.injections[this.injections.length - 1]?.position ?? "append";
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === "system") {
                if (position === "replace") {
                    messages[i] = { ...messages[i], content: injectedContent };
                }
                else if (position === "prepend") {
                    messages[i] = { ...messages[i], content: `${injectedContent}\n\n${messages[i].content}` };
                }
                else {
                    messages[i] = { ...messages[i], content: `${messages[i].content}\n\n${injectedContent}` };
                }
                break;
            }
        }
        if (!messages.some(m => m.role === "system")) {
            messages.unshift({ role: "system", content: injectedContent });
        }
        return this.getInner().chat({ ...req, messages }, signal);
    }
}
exports.default = PromptInjectProvider;
module.exports = PromptInjectProvider;
