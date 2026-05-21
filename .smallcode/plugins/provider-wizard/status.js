// Provider Wizard — config status detection
// Reads .env file, env vars, and smallcode.toml to report current state.

const fs = require('fs');
const path = require('path');

const PROVIDERS = {
  lmstudio: { name: 'LM Studio', defaultUrl: 'http://localhost:1234/v1', keyEnv: null },
  ollama: { name: 'Ollama', defaultUrl: 'http://localhost:11434/v1', keyEnv: null },
  openrouter: { name: 'OpenRouter', defaultUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENAI_API_KEY' },
  openai: { name: 'OpenAI', defaultUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
  anthropic: { name: 'Anthropic', defaultUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY' },
  deepseek: { name: 'DeepSeek', defaultUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY' },
  custom: { name: 'Custom endpoint', defaultUrl: '', keyEnv: null },
};

function parseEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
    return vars;
  } catch {
    return {};
  }
}

function getStatus() {
  const cwd = process.cwd();
  const envFile = path.join(cwd, '.env');
  const tomlFile = path.join(cwd, 'smallcode.toml');

  const envFileVars = parseEnvFile(envFile);

  const provider = process.env.SMALLCODE_PROVIDER || envFileVars.SMALLCODE_PROVIDER || 'openai';
  const baseUrl = process.env.SMALLCODE_BASE_URL || envFileVars.SMALLCODE_BASE_URL || '';
  const model = process.env.SMALLCODE_MODEL || envFileVars.SMALLCODE_MODEL || '';

  // API keys: env var > .env file
  const apiKeys = {};
  for (const [id, info] of Object.entries(PROVIDERS)) {
    if (!info.keyEnv) continue;
    apiKeys[id] = process.env[info.keyEnv] || envFileVars[info.keyEnv] || null;
  }

  // Escalation from smallcode.toml
  let escalation = null;
  try {
    const content = fs.readFileSync(tomlFile, 'utf-8');
    const lines = content.split('\n');
    let inEscalation = false;
    for (const line of lines) {
      if (line.trim() === '[escalation]') { inEscalation = true; continue; }
      if (line.trim().startsWith('[') && inEscalation) break;
      if (inEscalation) {
        const pMatch = line.match(/^provider\s*=\s*"?([^"#]+)"?/);
        if (pMatch) escalation = { provider: pMatch[1].trim() };
        const mMatch = line.match(/^model\s*=\s*"?([^"#]+)"?/);
        if (mMatch && escalation) escalation.model = mMatch[1].trim();
      }
    }
  } catch {}

  // Check if key matches provider
  const keyForProvider = PROVIDERS[provider]?.keyEnv ? apiKeys[provider] : true; // local providers don't need keys
  const hasValidKey = keyForProvider === true || !!keyForProvider;

  return {
    provider,
    baseUrl: baseUrl || PROVIDERS[provider]?.defaultUrl || '',
    model,
    hasValidKey,
    apiKeys,
    escalation,
    envFileExists: fs.existsSync(envFile),
    providers: PROVIDERS,
  };
}

function formatStatus(status) {
  const lines = [];
  lines.push(`  Provider:    ${status.provider}`);
  lines.push(`  Base URL:    ${status.baseUrl}`);
  lines.push(`  Model:       ${status.model || '(not set)'}`);
  lines.push(`  API Key:     ${status.hasValidKey ? 'set' : 'missing'}`);
  lines.push(`  Escalation:  ${status.escalation ? `${status.escalation.provider} / ${status.escalation.model || 'default'}` : 'none'}`);
  lines.push(`  Config file: ${status.envFileExists ? '.env exists' : 'no .env file'}`);

  // Show which keys are present
  const keyStatuses = [];
  for (const [id, val] of Object.entries(status.apiKeys)) {
    if (val) keyStatuses.push(`${id}=***`);
  }
  if (keyStatuses.length) {
    lines.push(`  Keys found:  ${keyStatuses.join(', ')}`);
  }

  return lines.join('\n');
}

module.exports = { PROVIDERS, getStatus, formatStatus, parseEnvFile };
