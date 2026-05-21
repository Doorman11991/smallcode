// Provider Wizard — interactive readline wizard
// Shared logic for /provider command and configure_provider tool

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PROVIDERS, parseEnvFile } = require('./status');

async function ask(rl, question, defaultVal) {
  return new Promise((resolve) => {
    const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

async function askNumber(rl, question, options) {
  return new Promise((resolve) => {
    const prompt = `${question}\n${options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}\n> `;
    rl.question(prompt, (answer) => {
      const n = parseInt(answer.trim()) - 1;
      resolve(n >= 0 && n < options.length ? n : -1);
    });
  });
}

async function askYesNo(rl, question, defaultYes = true) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise((resolve) => {
    rl.question(`${question} ${suffix} `, (answer) => {
      const val = answer.trim().toLowerCase();
      if (!val) return resolve(defaultYes);
      resolve(val === 'y' || val === 'yes');
    });
  });
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

async function validateApiKey(provider, apiKey, baseUrl) {
  if (!apiKey) return { valid: false, error: 'No API key provided' };

  const info = PROVIDERS[provider];
  if (!info || !info.keyEnv) return { valid: true, error: null }; // local providers, skip check

  const url = (baseUrl || info.defaultUrl || '').replace(/\/+$/, '');
  if (!url) return { valid: true, error: null }; // no URL to validate against

  try {
    const res = await fetch(`${url}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { valid: true, error: null };
    if (res.status === 401) return { valid: false, error: 'Invalid API key (got 401)' };
    if (res.status === 403) return { valid: false, error: 'API key rejected (got 403)' };
    // Some providers return 400 for /models but key is valid
    return { valid: true, error: null };
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      return { valid: false, error: 'Request timed out — check your network' };
    }
    return { valid: false, error: `Connection failed: ${e.message}` };
  }
}

function mergeEnvFile(filePath, newVars) {
  let lines = [];
  try {
    lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  } catch {}

  const keys = new Set(Object.keys(newVars));
  const result = [];
  const written = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (eq !== -1) {
      const key = trimmed.slice(0, eq).trim();
      if (keys.has(key)) {
        result.push(`${key}=${newVars[key]}`);
        written.add(key);
        continue;
      }
    }
    result.push(line);
  }

  // Append new keys that weren't in the file
  const newEntries = Object.entries(newVars).filter(([k]) => !written.has(k));
  if (newEntries.length) {
    if (result.length && result[result.length - 1].trim() !== '') result.push('');
    result.push('# Provider configuration (added by /provider wizard)');
    for (const [k, v] of newEntries) {
      result.push(`${k}=${v}`);
    }
  }

  return result.join('\n');
}

async function runWizard(options = {}) {
  const isInteractive = options.interactive !== false;
  const cwd = process.cwd();
  const envPath = path.join(cwd, '.env');
  const tomlPath = path.join(cwd, 'smallcode.toml');
  const globalConfigDir = path.join(os.homedir(), '.config', 'smallcode');
  const globalEnvPath = path.join(globalConfigDir, '.env');

  // Load existing env
  const existingEnv = parseEnvFile(envPath);

  let rl = null;
  if (isInteractive) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  const choices = Object.entries(PROVIDERS);
  const providerNames = choices.map(([, p]) => p.name);

  try {
    if (isInteractive) {
      console.log('');
      console.log('  \x1b[1;36mProvider Wizard\x1b[0m');
      console.log('  Configure your LLM provider for SmallCode\n');
    }

    // Step 1: Select provider
    const providerKeys = choices.map(([k]) => k);
    let provider = options.provider || '';

    if (!provider && isInteractive) {
      const idx = await askNumber(rl, '  Select a provider:', providerNames);
      provider = idx >= 0 ? providerKeys[idx] : 'openai';
    }
    provider = provider || 'openai';
    const providerInfo = PROVIDERS[provider];

    if (!providerInfo) {
      return { success: false, error: `Unknown provider: ${provider}` };
    }

    if (isInteractive) {
      console.log(`  \x1b[32mSelected: ${providerInfo.name}\x1b[0m\n`);
    }

    // Step 2: Base URL
    let baseUrl = options.baseUrl || '';
    if (!baseUrl && isInteractive) {
      baseUrl = await ask(rl, `  Base URL for ${providerInfo.name}`, providerInfo.defaultUrl);
    }
    baseUrl = baseUrl || providerInfo.defaultUrl;

    // Step 3: API key (cloud providers only)
    let apiKey = options.apiKey || '';
    if (providerInfo.keyEnv && !apiKey) {
      const envKey = process.env[providerInfo.keyEnv] || existingEnv[providerInfo.keyEnv] || '';
      if (isInteractive) {
        if (envKey) {
          console.log(`  API key found in ${providerInfo.keyEnv}: ${maskKey(envKey)}`);
          const change = await askYesNo(rl, '  Change it?', false);
          if (change) {
            apiKey = await ask(rl, `  API key for ${providerInfo.name}`, '');
          } else {
            apiKey = envKey;
          }
        } else {
          apiKey = await ask(rl, `  API key for ${providerInfo.name} (${providerInfo.keyEnv})`, '');
        }
      } else {
        apiKey = envKey;
      }
    } else if (!providerInfo.keyEnv && isInteractive) {
      console.log(`  No API key needed for ${providerInfo.name} (local provider)\n`);
    }

    // Step 4: Validate API key
    if (providerInfo.keyEnv && apiKey && isInteractive) {
      process.stdout.write('  Validating API key...');
      const result = await validateApiKey(provider, apiKey, baseUrl);
      if (result.valid) {
        console.log(` \x1b[32mvalid\x1b[0m`);
      } else {
        console.log(` \x1b[31m${result.error}\x1b[0m`);
        const retry = await askYesNo(rl, '  Continue anyway?', false);
        if (!retry) {
          return { success: false, error: result.error };
        }
      }
    }

    // Step 5: Model name
    const defaultModels = {
      lmstudio: '',
      ollama: '',
      openrouter: 'openai/gpt-4o-mini',
      openai: 'gpt-4o-mini',
      anthropic: 'claude-sonnet-4-5',
      deepseek: 'deepseek-coder',
      custom: '',
    };
    let model = options.model || '';
    if (!model && isInteractive) {
      model = await ask(rl, '  Model name', defaultModels[provider] || '');
    }
    model = model || defaultModels[provider] || '';

    // Step 6: Escalation (optional)
    let escalationProvider = options.escalationProvider || '';
    let escalationModel = options.escalationModel || '';
    if (isInteractive) {
      const setupEsc = await askYesNo(rl, '  Configure a fallback/escalation provider?', false);
      if (setupEsc) {
        const escChoices = providerNames;
        const escIdx = await askNumber(rl, '  Select escalation provider:', escChoices);
        if (escIdx >= 0 && escIdx < providerKeys.length) {
          escalationProvider = providerKeys[escIdx];
          const escDefault = defaultModels[escalationProvider] || '';
          escalationModel = await ask(rl, '  Escalation model', escDefault);
        }
      }
    }

    // Step 7: Write provider config to global env (~/.config/smallcode/smallcode.env)
    // so it persists across projects. Project .env can still override.
    const envVars = {
      SMALLCODE_PROVIDER: provider,
      SMALLCODE_BASE_URL: baseUrl,
      SMALLCODE_MODEL: model,
    };
    if (providerInfo.keyEnv && apiKey) {
      envVars[providerInfo.keyEnv] = apiKey;
    }

    // Always write to global config
    try {
      fs.mkdirSync(globalConfigDir, { recursive: true });
      const globalMerged = mergeEnvFile(globalEnvPath, envVars);
      fs.writeFileSync(globalEnvPath, globalMerged, 'utf-8');
    } catch {}

    // Also write to project .env if it exists or if we're in the project root
    if (fs.existsSync(envPath) || fs.existsSync(tomlPath)) {
      const merged = mergeEnvFile(envPath, envVars);
      fs.writeFileSync(envPath, merged, 'utf-8');
    }

    // Step 8: Write escalation to smallcode.toml
    if (escalationProvider) {
      let tomlContent = '';
      try { tomlContent = fs.readFileSync(tomlPath, 'utf-8'); } catch {}

      const escBlock = [
        '',
        '[escalation]',
        `provider = "${escalationProvider}"`,
        escalationModel ? `model = "${escalationModel}"` : '',
      ].filter(Boolean).join('\n') + '\n';

      if (tomlContent.includes('[escalation]')) {
        // Replace existing escalation section
        const start = tomlContent.indexOf('[escalation]');
        let end = tomlContent.length;
        const nextSection = tomlContent.indexOf('\n[', start + 1);
        if (nextSection !== -1) end = nextSection;
        tomlContent = tomlContent.slice(0, start).trimEnd() + '\n\n' + escBlock + tomlContent.slice(end).trimStart();
      } else {
        tomlContent = tomlContent.trimEnd() + '\n' + escBlock;
      }
      fs.writeFileSync(tomlPath, tomlContent.trimEnd() + '\n', 'utf-8');
    }

    // Summary
    const result = {
      success: true,
      provider: providerInfo.name,
      baseUrl,
      model,
      key: providerInfo.keyEnv ? maskKey(apiKey) : 'n/a',
      escalation: escalationProvider
        ? `${PROVIDERS[escalationProvider]?.name || escalationProvider}${escalationModel ? ' / ' + escalationModel : ''}`
        : null,
    };

    if (isInteractive) {
      console.log('');
      console.log('  \x1b[1;32mConfiguration written!\x1b[0m');
      console.log(`  \x1b[2m  Provider:   ${result.provider}\x1b[0m`);
      console.log(`  \x1b[2m  Base URL:   ${result.baseUrl}\x1b[0m`);
      console.log(`  \x1b[2m  Model:      ${result.model}\x1b[0m`);
      console.log(`  \x1b[2m  API Key:    ${result.key}\x1b[0m`);
      if (result.escalation) {
        console.log(`  \x1b[2m  Escalation: ${result.escalation}\x1b[0m`);
      }
      console.log('');
      console.log('  \x1b[33mRestart SmallCode to apply changes.\x1b[0m');
      console.log('');
    }

    return result;

  } finally {
    if (rl) rl.close();
  }
}

module.exports = { runWizard, ask, askNumber, askYesNo, validateApiKey, mergeEnvFile };
