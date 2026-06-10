// SmallCode — Boolean Logic Verifier
// Wraps boolean-algebra-engine to give the agent a deterministic,
// zero-hallucination check for boolean expressions.
//
// Why: small LLMs get ~20% of boolean satisfiability questions wrong
// (empirical benchmark across 7 models). This tool catches what the model
// misses before bad conditional logic lands in generated code.
//
// Falls back gracefully with an install hint if the engine is absent.
// Optional dep: pip install boolean-algebra-engine

const { execSync } = require('child_process');

let _engineAvailable = null;

function _checkEngine() {
  if (_engineAvailable !== null) return _engineAvailable;
  try {
    execSync('python3 -c "import boolean_algebra_engine"', { stdio: 'pipe', timeout: 5000 });
    _engineAvailable = true;
  } catch {
    _engineAvailable = false;
  }
  return _engineAvailable;
}

function _evaluate(expression) {
  // Single-quote the expression; escape any embedded single quotes
  const safe = expression.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const script = [
    'from boolean_algebra_engine import evaluate',
    `t,_=evaluate('${safe}')`,
    'import json',
    'print(json.dumps({"satisfiable":t.satisfiable,"variables":t.variables,"minterms":t.minterms,"maxterms":t.maxterms}))',
  ].join(';');
  const out = execSync(`python3 -c '${script}'`, { stdio: 'pipe', timeout: 10000 });
  return JSON.parse(out.toString().trim());
}

const verifyLogicTool = {
  type: 'function',
  function: {
    name: 'verify_logic',
    description:
      'Verify a boolean expression for contradictions, tautologies, and satisfiability. ' +
      'Use before committing complex if-else chains, access-control rules, or routing conditions — ' +
      'small models hallucinate on boolean logic, this tool is deterministic. ' +
      "Operators: AND (.), OR (+), NOT (!). E.g. \"A.!A\" is a contradiction; \"(A+B).C\" is satisfiable.",
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: "Boolean expression. AND='.', OR='+', NOT='!'. E.g. \"(A+B).!A\" or \"P.Q+!P.!Q\"",
        },
      },
      required: ['expression'],
    },
  },
};

async function executeVerifyLogic({ expression }) {
  if (!expression || typeof expression !== 'string') {
    return { error: 'expression must be a non-empty string' };
  }

  if (!_checkEngine()) {
    return {
      error: 'boolean-algebra-engine not found',
      hint: 'Run: pip install boolean-algebra-engine',
      docs: 'https://github.com/Shrivastava-Aditya/boolean-algebra-engine',
    };
  }

  try {
    const result = _evaluate(expression);
    const totalCases = Math.pow(2, result.variables.length);
    const isContradiction = !result.satisfiable;
    const isTautology = result.satisfiable && result.maxterms.length === 0;

    return {
      expression,
      satisfiable: result.satisfiable,
      contradiction: isContradiction,
      tautology: isTautology,
      variables: result.variables,
      satisfying_cases: result.minterms.length,
      total_cases: totalCases,
      verdict: isContradiction
        ? 'CONTRADICTION — condition can never be true; this branch is dead code'
        : isTautology
        ? 'TAUTOLOGY — condition is always true; else branch is dead code'
        : `SATISFIABLE — true in ${result.minterms.length}/${totalCases} cases`,
    };
  } catch (err) {
    return { error: `Evaluation failed: ${err.message}`, expression };
  }
}

module.exports = { verifyLogicTool, executeVerifyLogic };
