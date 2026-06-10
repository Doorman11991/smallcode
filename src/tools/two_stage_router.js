// SmallCode — 2-Stage Tool Router (Runtime)
// Compiled from: src/tools/router.ms
//
// Stage 1: Model picks a CATEGORY (read/write/search/run/plan/code_intel)
//   - Only ~200 tokens of category descriptions in context
// Stage 2: System injects only that category's full tool schemas
//   - Model makes specific tool call
//
// For models with >16k context: use "direct" mode (all tools at once)
// For models with ≤16k context: use "two_stage" mode
// Configurable via SMALLCODE_TOOL_ROUTING=direct|two_stage

const TOOL_CATEGORIES = {
  read: {
    description: 'Read file contents, find files by pattern',
    tools: ['read_file', 'find_files', 'find_and_read'],
  },
  write: {
    description: 'Create files, edit files with patch, rewrite files',
    tools: ['write_file', 'patch', 'read_and_patch', 'create_and_run'],
  },
  search: {
    description: 'Search code by regex, search code graph, explain symbols',
    tools: ['search', 'search_and_read', 'graph_search', 'explain_symbol', 'list_projects', 'hybrid_search'],
  },
  run: {
    description: 'Run shell commands, execute scripts',
    tools: ['bash', 'run'],
  },
  plan: {
    description: 'Load/save project memory, BoneScript compile/check, verify boolean logic',
    tools: ['memory_load', 'memory_remember', 'bone_compile', 'bone_check', 'verify_logic'],
  },
};

/**
 * Determine routing mode based on model's context window.
 * @param {number} contextWindow - Model's context length in tokens
 * @param {string} envOverride - SMALLCODE_TOOL_ROUTING env var
 * @returns {"direct"|"two_stage"}
 */
function getRoutingMode(contextWindow, envOverride) {
  if (envOverride === 'direct') return 'direct';
  if (envOverride === 'two_stage') return 'two_stage';
  // Auto: use 2-stage for models with ≤16k context
  return contextWindow <= 16384 ? 'two_stage' : 'direct';
}

/**
 * Get the category selector tool definition (Stage 1).
 * This is a lightweight "tool" that just asks the model to pick a category.
 */
function getCategorySelectorTool() {
  return {
    type: 'function',
    function: {
      name: 'select_category',
      description: 'Pick the tool category you need. Categories: read (read/find files), write (create/edit files), search (grep/code graph), run (shell commands), plan (memory/bonescript).',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: Object.keys(TOOL_CATEGORIES),
            description: 'Tool category needed for your next action',
          },
        },
        required: ['category'],
      },
    },
  };
}

/**
 * Get tool schemas filtered by category (Stage 2).
 * @param {string} category - The selected category
 * @param {Array} allTools - Full tool definition array
 * @returns {Array} Filtered tool definitions
 */
function getToolsForCategory(category, allTools) {
  const cat = TOOL_CATEGORIES[category];
  if (!cat) return allTools; // Unknown category, fall back to all
  return allTools.filter(t => cat.tools.includes(t.function.name));
}

/**
 * Estimate token savings from 2-stage routing.
 * @param {Array} allTools - Full tool array
 * @returns {{directTokens: number, twoStageTokens: number, savings: number}}
 */
function estimateSavings(allTools) {
  const directTokens = Math.ceil(JSON.stringify(allTools).length / 4);
  const selectorTokens = Math.ceil(JSON.stringify(getCategorySelectorTool()).length / 4);
  // Average category has ~3 tools
  const avgCategoryTokens = Math.ceil(directTokens / Object.keys(TOOL_CATEGORIES).length);
  const twoStageTokens = selectorTokens + avgCategoryTokens;
  return {
    directTokens,
    twoStageTokens,
    savings: Math.round((1 - twoStageTokens / directTokens) * 100),
  };
}

module.exports = {
  TOOL_CATEGORIES,
  getRoutingMode,
  getCategorySelectorTool,
  getToolsForCategory,
  estimateSavings,
};
