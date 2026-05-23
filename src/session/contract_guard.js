// SmallCode — Contract Done-Guard
//
// The hard-fail half of the Definition-of-Done feature. When a contract is
// active and any assertion is still `pending` or `failed`, the agent is not
// allowed to deliver a final "I'm done"–shaped assistant message. We don't
// edit the model's text; we recognise the shape and inject a system message
// that nudges the model to either:
//   - call contract_status to see what's blocking, or
//   - run/observe the right command and call contract_assert_pass.
//
// Heuristic-only — we never rewrite or block the *first* informational reply
// even if it looks like a wrap-up, because false positives hurt a lot. The
// guard only fires when the model claims completion without resolving every
// assertion.
//
// Configuration:
//   SMALLCODE_CONTRACT=false   skip the guard entirely

'use strict';

const { getStore } = require('./contract_store');

// Phrases that strongly suggest the model is wrapping up. Conservative — we
// only act when at least one of these matches AND a contract is open AND
// real blockers exist.
const DONE_PATTERNS = [
  /\b(all\s+)?done\b/i,
  /\btask (is\s+)?(now\s+)?(complete|completed|finished|done)\b/i,
  /\b(everything|all)\s+(is\s+)?(done|working|set|complete)\b/i,
  /\b(finished|completed)\s+(the\s+)?task\b/i,
  /\b(implementation|feature|fix)\s+(is\s+)?(complete|done|finished)\b/i,
  /\bsuccessfully\s+(implemented|completed|finished)\b/i,
  /\bready\s+to\s+(ship|merge|use)\b/i,
];

function looksLikeDoneClaim(text) {
  if (!text || typeof text !== 'string') return false;
  // Skip if the text reads like a question or asks for input.
  if (/[?]\s*$/.test(text.trim())) return false;
  for (const re of DONE_PATTERNS) if (re.test(text)) return true;
  return false;
}

/**
 * Inspect a candidate final assistant message. If it claims completion while
 * the active contract still has blockers, return an injection payload the
 * caller can splice into history. Otherwise return null.
 *
 * Caller wires in the agent loop (bin/smallcode.js):
 *   const guard = checkDoneGuard(message.content, cwd);
 *   if (guard) {
 *     conversationHistory.push({ role: 'assistant', content: message.content });
 *     conversationHistory.push({ role: 'user', content: guard.injection });
 *     continue; // re-prompt the model; do NOT break the loop
 *   }
 */
function checkDoneGuard(content, cwd) {
  if (process.env.SMALLCODE_CONTRACT === 'false') return null;
  if (!looksLikeDoneClaim(content)) return null;

  let store, c;
  try {
    store = getStore(cwd || process.cwd());
    c = store.active();
  } catch {
    return null;
  }
  if (!c) return null; // no active contract → guard inactive

  const ds = c.doneStatus();
  if (ds.done) return null; // contract is fully resolved — let the response through

  const blockerLines = ds.blockers
    .map((b) => `  - ${b.id} (${b.state}) ${b.text}`)
    .join('\n');

  const injection =
`[CONTRACT-GUARD] You claimed the task is complete, but the active contract "${c.title}" (${c.id}) still has unresolved assertions:

${blockerLines}

You cannot deliver a final response while assertions are pending or failed. Do one of the following before claiming done:

  1. Run the right command(s) and call contract_assert_pass <id> with evidence
  2. Call contract_assert_fail <id> with the actual failure (if it really is broken)
  3. Call contract_assert_skip <id> with a reason (if it is genuinely out of scope)
  4. Call contract_status to refresh the assertion list

If you are blocked from completing an assertion, explain the specific blocker and ask the user — do not claim completion. Disable this guard with SMALLCODE_CONTRACT=false.`;

  return {
    injection,
    contractId: c.id,
    blockers: ds.blockers,
  };
}

module.exports = { checkDoneGuard, looksLikeDoneClaim, DONE_PATTERNS };
