#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { RagIndexStore } = require('../src/rag/index_store');
const { ensureRepo, collectSnippets } = require('../src/rag/github_scraper');

function loadConfig() {
  const cfgPath = process.env.SMALLCODE_RAG_REPOS || path.join(process.cwd(), '.smallcode', 'rag', 'repos.json');
  if (!fs.existsSync(cfgPath)) {
    console.error(`Missing repo list: ${cfgPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
}

(function main() {
  const cfg = loadConfig();
  const repoDir = cfg.cacheDir || path.join(process.cwd(), '.smallcode', 'rag', 'repos');
  fs.mkdirSync(repoDir, { recursive: true });
  const store = new RagIndexStore({ path: cfg.indexPath });
  store.load();

  let total = 0;
  for (const url of (cfg.repos || [])) {
    const local = ensureRepo(url, repoDir);
    const snippets = collectSnippets(local, url);
    total += snippets.length;
    store.upsertMany(snippets);
    process.stdout.write(`indexed ${snippets.length} snippets from ${url}\n`);
  }
  store.save();
  process.stdout.write(`done. total snippets: ${total}\n`);
})();
