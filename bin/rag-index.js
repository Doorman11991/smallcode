#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const readline = require('readline');
const { RagIndexStore } = require('../src/rag/index_store');

function usage() {
  console.log(`Usage: smallcode-rag-index [--config PATH] [--preset starter|broad|none] [--repo URL_OR_PATH]

Builds .smallcode/rag/index.json from snippet-sized code chunks scraped by scripts/rag_scraper.py.

Config example (.smallcode/rag/repos.json):
{
  "preset": "starter",
  "repos": ["https://github.com/owner/repo.git"],
  "maxFilesPerRepo": 1000,
  "maxSnippetsPerRepo": 4000,
  "chunkLines": 80
}

Presets:
  starter  curated multi-language framework/library set (default when no config exists)
  broad    larger curated corpus across Python, JS/TS, Go, Rust, Java, C#, Ruby, PHP, C/C++
  none     only scrape repos listed in config or --repo
`);
}

function parseArgs(argv) {
  const args = { repos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--preset') args.preset = argv[++i];
    else if (a === '--repo') args.repos.push(argv[++i]);
    else if (a === '--index-path') args.indexPath = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function findPython() {
  for (const bin of ['python3', 'python']) {
    const r = cp.spawnSync(bin, ['--version'], { encoding: 'utf-8' });
    if (r.status === 0) return bin;
  }
  throw new Error('Python 3 is required for the RAG scraper (tried python3 and python).');
}

async function loadJsonl(file, onRecord) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    onRecord(JSON.parse(line));
    count++;
  }
  return count;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }

  const configPath = args.config || process.env.SMALLCODE_RAG_REPOS || path.join(process.cwd(), '.smallcode', 'rag', 'repos.json');
  const cfg = readConfig(configPath);
  const indexPath = args.indexPath || cfg.indexPath || path.join(process.cwd(), '.smallcode', 'rag', 'index.json');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-rag-'));
  const jsonlPath = path.join(tmpDir, 'snippets.jsonl');
  const scraper = path.join(__dirname, '..', 'scripts', 'rag_scraper.py');

  const pyArgs = [scraper, '--out', jsonlPath];
  if (fs.existsSync(configPath)) pyArgs.push('--config', configPath);
  if (args.preset) pyArgs.push('--preset', args.preset);
  for (const repo of args.repos) pyArgs.push('--repo', repo);

  const py = findPython();
  const scrape = cp.spawnSync(py, pyArgs, { cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit'] });
  if (scrape.status !== 0) process.exit(scrape.status || 1);

  const store = new RagIndexStore({ path: indexPath });
  store.load();
  const batch = [];
  let total = 0;
  await loadJsonl(jsonlPath, (rec) => {
    batch.push(rec);
    if (batch.length >= 1000) {
      store.upsertMany(batch.splice(0, batch.length));
    }
    total++;
  });
  if (batch.length) store.upsertMany(batch);
  store.save();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.stdout.write(`indexed ${total} snippets into ${indexPath}\n`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
