// SmallCode — Tool Call Extractor
//
// Some local models (notably qwen2.5-coder, hermes, llama3-instruct via Ollama,
// and various GGUFs through llama.cpp) do not always emit structured
// `tool_calls` over the OpenAI-compatible endpoint. Instead, they paste the
// tool invocation as JSON text inside `message.content`.
//
// Symptoms reported in the wild (e.g. issue #36 — qwen2.5-coder:14b on Ollama):
//   • User asks "what files are in this directory?"
//   • Model returns a chat message whose content is literally a JSON blob:
//       <tool_call>{"name":"shell","arguments":{"cmd":"ls"}}</tool_call>
//     or sometimes a bare ```json fenced block, or even just `{ "name": ... }`.
//   • The agent loop sees no `tool_calls`, treats the JSON as chat output,
//     and the user sees the raw JSON instead of the tool running.
//
// This module is a defensive recovery layer. Given the model's `message`
// object and the list of available tool schemas, it tries to detect
// embedded tool invocations and rewrite the message in-place to use the
// proper `tool_calls` shape — so the rest of the agent loop can treat
// every model the same way.
//
// Recognised formats (in priority order):
//   1. <tool_call>{...}</tool_call>           ← Hermes / qwen2.5 native
//   2. ```json ... ```  (fenced code block)   ← qwen-coder / generic
//   3. ```tool_call ... ```                   ← some llama3 fine-tunes
//   4. Bare JSON object at the start of content
//
// All formats expect the JSON to be of shape:
//   { "name": "<tool_name>", "arguments": <object> }
// or the OpenAI variant:
//   { "function": { "name": "<tool_name>", "arguments": "<json string>" } }
// or an array of either.
//
// Conservative by design: if the JSON doesn't reference a known tool, we
// leave the content alone — better to show the user a JSON blob than to
// invent tool calls.

'use strict';

// Match <tool_call>...</tool_call> (qwen / hermes). Multiline + non-greedy.
const TOOL_CALL_TAG_RE = /<tool[_\-]?call>\s*([\s\S]*?)\s*<\/tool[_\-]?call>/gi;

// Match ```json ... ``` and ```tool_call ... ``` fences.
const FENCED_RE = /```(?:json|tool_?call)?\s*\n?([\s\S]*?)\n?```/gi;

// Match a bare JSON object/array at the very start of content (whitespace ok).
const LEADING_JSON_RE = /^\s*([{\[][\s\S]+[}\]])\s*$/;

/**
 * @param {object} message       OpenAI-style choice.message; has .content + maybe .tool_calls
 * @param {Array}  toolSchemas   Same shape passed to the model: [{ function: { name, ... } }, ...]
 * @returns {{ patched: boolean, addedCalls: number }}
 *
 * Mutates `message` in place when extraction succeeds.
 */
function extractFromMessage(message, toolSchemas) {
  if (!message) return { patched: false, addedCalls: 0 };
  // Already has structured tool_calls — leave it alone.
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return { patched: false, addedCalls: 0 };
  }
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content) return { patched: false, addedCalls: 0 };

  const known = new Set();
  if (Array.isArray(toolSchemas)) {
    for (const t of toolSchemas) {
      const n = t?.function?.name || t?.name;
      if (typeof n === 'string') known.add(n);
    }
  }

  const calls = [];
  const consumedRanges = []; // [start, end) of content we transferred into tool_calls

  // 1. Tagged tool calls — strongest signal.
  for (const m of content.matchAll(TOOL_CALL_TAG_RE)) {
    const parsed = _safeParseAny(m[1]);
    for (const tc of _normalize(parsed, known)) calls.push(tc);
    if (parsed) consumedRanges.push([m.index, m.index + m[0].length]);
  }

  // 2. Fenced JSON blocks. Skipped if we already got tagged calls.
  if (calls.length === 0) {
    for (const m of content.matchAll(FENCED_RE)) {
      const parsed = _safeParseAny(m[1]);
      const normalized = _normalize(parsed, known);
      if (normalized.length > 0) {
        for (const tc of normalized) calls.push(tc);
        consumedRanges.push([m.index, m.index + m[0].length]);
      }
    }
  }

  // 3. Bare JSON — only if the content is essentially nothing-but-JSON,
  //    so we don't accidentally swallow an explanation paragraph that
  //    happens to mention a tool.
  if (calls.length === 0) {
    const m = content.match(LEADING_JSON_RE);
    if (m) {
      const parsed = _safeParseAny(m[1]);
      const normalized = _normalize(parsed, known);
      if (normalized.length > 0) {
        for (const tc of normalized) calls.push(tc);
        consumedRanges.push([0, content.length]);
      }
    }
  }

  if (calls.length === 0) return { patched: false, addedCalls: 0 };

  // Synthesise OpenAI-style tool_calls.
  message.tool_calls = calls.map((c, i) => ({
    id: `call_extracted_${Date.now()}_${i}`,
    type: 'function',
    function: {
      name: c.name,
      arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
    },
  }));

  // Strip the consumed JSON spans from content. Process in reverse so
  // indices stay valid.
  let newContent = content;
  consumedRanges.sort((a, b) => b[0] - a[0]);
  for (const [s, e] of consumedRanges) {
    newContent = newContent.slice(0, s) + newContent.slice(e);
  }
  message.content = newContent.trim();

  return { patched: true, addedCalls: calls.length };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _safeParseAny(text) {
  if (!text) return null;
  const trimmed = text.trim();
  // Strip trailing commas which Qwen sometimes emits.
  const cleaned = trimmed.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch {}
  // Multiple JSON objects newline-separated → wrap into array.
  const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length > 1) {
    const arr = [];
    for (const line of lines) {
      try { arr.push(JSON.parse(line.replace(/,(\s*[}\]])/g, '$1'))); } catch { return null; }
    }
    return arr.length > 0 ? arr : null;
  }
  return null;
}

// Normalise whatever the model emitted into [{ name, arguments }, ...].
// Filters out entries that don't reference a known tool, when we have a
// known-tool list. Without a list, accepts anything name-shaped.
function _normalize(parsed, knownNames) {
  if (!parsed) return [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const tc = _coerceOne(item);
    if (!tc) continue;
    if (knownNames.size > 0 && !knownNames.has(tc.name)) continue;
    out.push(tc);
  }
  return out;
}

function _coerceOne(item) {
  // Form A: { name, arguments }
  if (typeof item.name === 'string') {
    return { name: item.name, arguments: item.arguments ?? item.parameters ?? {} };
  }
  // Form B: { function: { name, arguments } } — OpenAI shape inline.
  if (item.function && typeof item.function.name === 'string') {
    return { name: item.function.name, arguments: item.function.arguments ?? {} };
  }
  // Form C: { tool, args } — some custom prompts.
  if (typeof item.tool === 'string') {
    return { name: item.tool, arguments: item.args ?? item.arguments ?? {} };
  }
  return null;
}

module.exports = { extractFromMessage };
