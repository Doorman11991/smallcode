'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RagIndexStore } = require('../src/rag/index_store');
const { RagRetriever, planQuery } = require('../src/rag/retriever');

test('RAG index ranks related snippets first', () => {
  const store = new RagIndexStore({ path: '/tmp/nonexistent.json' });
  store.upsertMany([
    { id: '1', path: 'a.py', code: 'def binary_search(arr, x):\n  pass' },
    { id: '2', path: 'b.js', code: 'function renderButton() { return "ok" }' },
  ]);
  const hits = store.search('how to implement binary search in python', 1);
  assert.equal(hits[0].id, '1');
});

test('query planning detects debug intent', () => {
  const p = planQuery('fix stack error in parser');
  assert.equal(p.intent, 'debug');
});

test('retriever formats snippets for prompt injection', () => {
  const store = new RagIndexStore({ path: '/tmp/nonexistent.json' });
  store.upsertMany([
    { id: '1', repo: 'local', path: 'router.ts', startLine: 7, lang: 'ts', code: 'export function routeRequest() { return true }' },
  ]);
  const retriever = new RagRetriever({ index: store });
  retriever.loaded = true;
  const prompt = retriever.formatForPrompt('route request in typescript', { limit: 1 });
  assert.match(prompt, /RAG_CODE_CONTEXT/);
  assert.match(prompt, /router\.ts:7/);
});
