'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { RagIndexStore } = require('../src/rag/index_store');
const { RagRetriever, planQuery } = require('../src/rag/retriever');

test('hybrid RAG index ranks related snippets first', () => {
  const store = new RagIndexStore({ path: '/tmp/nonexistent.json' });
  store.upsertMany([
    { id: '1', path: 'a.py', lang: 'python', symbol: 'binary_search', code: 'def binary_search(arr, x):\n  pass' },
    { id: '2', path: 'b.js', lang: 'javascript', symbol: 'renderButton', code: 'function renderButton() { return "ok" }' },
  ]);
  const hits = store.search('how to implement binary search in python', 1);
  assert.equal(hits[0].id, '1');
  assert.ok(hits[0].bm25Score > 0);
});

test('BM25 exact API names beat vague vector-only matches', () => {
  const store = new RagIndexStore({ path: '/tmp/nonexistent.json' });
  store.upsertMany([
    { id: 'api', path: 'auth.ts', lang: 'typescript', symbol: 'createAccessToken', code: 'export function createAccessToken(userId: string) { return jwt.sign({ userId }, secret) }' },
    { id: 'vague', path: 'misc.ts', lang: 'typescript', symbol: 'createThing', code: 'export function createThing(value: string) { return value.toLowerCase() }' },
  ]);
  const hits = store.search('createAccessToken jwt auth token', 2);
  assert.equal(hits[0].id, 'api');
});

test('query planning detects debug intent', () => {
  const p = planQuery('fix stack error in parser');
  assert.equal(p.intent, 'debug');
});

test('retriever formats snippets for prompt injection', () => {
  const store = new RagIndexStore({ path: '/tmp/nonexistent.json' });
  store.upsertMany([
    { id: '1', repo: 'local', path: 'router.ts', startLine: 7, lang: 'ts', symbol: 'routeRequest', code: 'export function routeRequest() { return true }' },
  ]);
  const retriever = new RagRetriever({ index: store });
  retriever.loaded = true;
  const prompt = retriever.formatForPrompt('route request in typescript', { limit: 1 });
  assert.match(prompt, /RAG_CODE_CONTEXT/);
  assert.match(prompt, /router\.ts:7 routeRequest/);
  assert.match(prompt, /bm25=/);
});

test('python scraper emits snippet-sized symbol chunks from local repos', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smallcode-rag-scraper-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const source = [
    'def alpha_search(items, needle):',
    '    for item in items:',
    '        if item == needle:',
    '            return item',
    '    return None',
    '',
    'class BetaCache:',
    '    def __init__(self):',
    '        self.items = {}',
    '    def get(self, key):',
    '        return self.items.get(key)',
  ].join('\n');
  fs.writeFileSync(path.join(repo, 'sample.py'), source);
  const out = path.join(tmp, 'snippets.jsonl');
  const result = cp.spawnSync('python3', [
    path.join(__dirname, '..', 'scripts', 'rag_scraper.py'),
    '--preset', 'none',
    '--repo', repo,
    '--out', out,
    '--min-chars', '20',
    '--chunk-lines', '6',
  ], { encoding: 'utf-8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = fs.readFileSync(out, 'utf-8').trim().split('\n').map(JSON.parse);
  assert.ok(lines.length >= 2);
  assert.equal(lines[0].kind, 'symbol');
  assert.equal(lines[0].path, 'sample.py');
  assert.ok(lines.every(s => s.code.split('\n').length <= 6));
});
