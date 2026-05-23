// SmallCode — Parallel Executor (Feature 1)
//
// Executes independent plan steps concurrently instead of sequentially.
// Gated behind SMALLCODE_PARALLEL=true (off by default until validated).
//
// Architecture:
//   - Receives batches from dependency_graph.toParallelBatches()
//   - Each batch: independent steps that can run simultaneously
//   - Per-step context: isolated messages array (system prompt + one task instruction)
//   - Results merged back into conversationHistory in dependency order
//
// Per-file isolation contract (from litecode design):
//   Each parallel executor call sees ONLY:
//     - The shared system prompt (read-only)
//     - Its own task instruction
//     - The content of its target file(s) only
//     - No sibling step results (prevents cross-contamination)
//
// Tool calls within each parallel step are executed normally via executeTool.

'use strict';

/**
 * Check if parallel execution is enabled.
 * @returns {boolean}
 */
function isParallelEnabled() {
  return process.env.SMALLCODE_PARALLEL === 'true';
}

/**
 * Build an isolated messages array for a single parallel step.
 * The step sees the system prompt and its task description, but NOT
 * the full conversation history (which would include sibling results).
 *
 * IMPORTANT: sharedSystemMessages must contain ONLY {role:'system'} entries —
 * not user/assistant turns. Callers should filter conversationHistory to
 * system messages before passing here to enforce per-file isolation.
 *
 * @param {object[]} sharedSystemMessages - [{role:'system', content:...}] only
 * @param {string} stepInstruction - the specific step text to execute
 * @returns {object[]}
 */
function buildStepMessages(sharedSystemMessages, stepInstruction) {
  // Safety: only allow system messages to prevent history bleed
  const systemOnly = (sharedSystemMessages || []).filter(m => m.role === 'system');
  return [
    ...systemOnly,
    { role: 'user', content: stepInstruction },
  ];
}

/**
 * Execute a single batch of steps concurrently.
 *
 * Each step is a mini agent loop:
 *   1. Build isolated message context (system + step instruction)
 *   2. Call chatCompletion with that context
 *   3. Execute any tool calls returned
 *   4. Return { stepIndex, toolResults, finalContent }
 *
 * Steps in the same batch run via Promise.all (concurrent).
 *
 * @param {number[]} batch - step indices to run concurrently
 * @param {string[]} planSteps - all plan step texts (for index lookup)
 * @param {object[]} systemMessages - shared system prompt messages
 * @param {Function} chatCompletionFn - (messages, config) → response
 * @param {Function} executeToolFn - (name, args, ctx) → result
 * @param {object} config - model config
 * @param {object} ctx - tool execution context
 * @returns {Promise<Array<{stepIndex: number, content: string, toolResults: object[]}>>}
 */
async function executeBatch(batch, planSteps, systemMessages, chatCompletionFn, executeToolFn, config, ctx) {
  const batchPromises = batch.map(async (stepIdx) => {
    const stepText = planSteps[stepIdx] || `Step ${stepIdx + 1}`;
    const messages = buildStepMessages(systemMessages, stepText);

    const toolResults = [];
    let finalContent = '';
    let iterations = 0;
    const MAX_ITERATIONS = 20; // per-step tool call limit

    try {
      let currentMessages = [...messages];

      while (iterations < MAX_ITERATIONS) {
        iterations++;
        const response = await chatCompletionFn(config, currentMessages);
        if (!response) break;

        const choice = response?.choices?.[0]?.message;
        if (!choice) break;

        // Recover tool calls embedded in text content (qwen2.5-coder etc.).
        // Issue #36 — the agent loop in bin/smallcode.js does the same.
        try {
          const { extractFromMessage } = require('../tools/tool_call_extractor');
          const tools = (typeof ctx?.getAllTools === 'function' ? ctx.getAllTools(config) : null) || [];
          extractFromMessage(choice, tools);
        } catch {}

        finalContent = choice.content || '';

        const toolCalls = choice.tool_calls || [];
        if (toolCalls.length === 0) break; // no more tool calls → step done

        // Execute tool calls sequentially within this step
        for (const tc of toolCalls) {
          const name = tc?.function?.name;
          const argsStr = tc?.function?.arguments || '{}';
          let args = {};
          try { args = JSON.parse(argsStr); } catch {}

          const result = await executeToolFn(name, args, ctx);
          const resultText = result?.result || result?.error || JSON.stringify(result);

          toolResults.push({ toolName: name, args, result: resultText });

          // Add tool call + result to this step's message history
          currentMessages.push({
            role: 'assistant',
            content: choice.content || '',
            tool_calls: toolCalls,
          });
          currentMessages.push({
            role: 'tool',
            tool_call_id: tc.id || String(Date.now()),
            content: resultText,
          });
        }
      }
    } catch (err) {
      // Individual step failure is non-fatal — mark with error and continue
      finalContent = `[parallel step ${stepIdx + 1} error: ${err.message}]`;
    }

    return { stepIndex: stepIdx, content: finalContent, toolResults };
  });

  return Promise.all(batchPromises);
}

/**
 * Run a full plan through the parallel executor.
 * Processes batches in order; within each batch, steps run concurrently.
 *
 * @param {number[][]} batches - from toParallelBatches()
 * @param {string[]} planSteps - all plan step texts
 * @param {object[]} systemMessages - shared system prompt messages
 * @param {Function} chatCompletionFn
 * @param {Function} executeToolFn
 * @param {object} config
 * @param {object} ctx
 * @param {Function} onBatchComplete - callback(batchIndex, results) for TUI updates
 * @returns {Promise<Array<{stepIndex, content, toolResults}>>}
 */
async function runParallelPlan(
  batches,
  planSteps,
  systemMessages,
  chatCompletionFn,
  executeToolFn,
  config,
  ctx,
  onBatchComplete,
) {
  const allResults = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchResults = await executeBatch(
      batch,
      planSteps,
      systemMessages,
      chatCompletionFn,
      executeToolFn,
      config,
      ctx,
    );

    for (const r of batchResults) {
      allResults[r.stepIndex] = r;
    }

    if (typeof onBatchComplete === 'function') {
      try { onBatchComplete(batchIdx, batchResults); } catch {}
    }
  }

  // Return results sorted by original step order
  return allResults.filter(Boolean);
}

/**
 * Merge parallel execution results into a single conversationHistory entry.
 * Creates a synthetic assistant message summarizing all step outcomes.
 *
 * @param {Array<{stepIndex, content, toolResults}>} results
 * @param {string[]} planSteps
 * @returns {object} - {role: 'assistant', content: string}
 */
function mergeParallelResults(results, planSteps) {
  const parts = results.map(r => {
    const stepNum = r.stepIndex + 1;
    const stepText = planSteps[r.stepIndex] || `Step ${stepNum}`;
    const toolSummary = r.toolResults.length > 0
      ? `\n  Tools used: ${r.toolResults.map(t => t.toolName).join(', ')}`
      : '';
    return `✓ Step ${stepNum}: ${stepText}${toolSummary}\n${r.content || ''}`.trim();
  });

  return {
    role: 'assistant',
    content: `Parallel execution complete:\n\n${parts.join('\n\n')}`,
  };
}

module.exports = {
  isParallelEnabled,
  buildStepMessages,
  executeBatch,
  runParallelPlan,
  mergeParallelResults,
};
