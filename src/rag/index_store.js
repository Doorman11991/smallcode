'use strict';

const fs = require('fs');
const path = require('path');

const DIMS = parseInt(process.env.SMALLCODE_RAG_DIMS || '1024', 10);
const BM25_K1 = 1.4;
const BM25_B = 0.72;

function splitIdentifier(token) {
  return String(token || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenize(text) {
  const raw = String(text || '').match(/[A-Za-z_][A-Za-z0-9_]*|\d+|#[A-Za-z0-9_-]+/g) || [];
  const out = [];
  for (const tok of raw) {
    const parts = splitIdentifier(tok);
    out.push(...parts);
    if (parts.length > 1) out.push(parts.join('_'));
  }
  return out.filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

function hashToken(token, dims = DIMS) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % dims;
}

function termFrequency(tokens) {
  const tf = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

function embed(text, dims = DIMS) {
  const vec = Object.create(null);
  const toks = tokenize(text);
  for (const t of toks) {
    const key = String(hashToken(t, dims));
    vec[key] = (vec[key] || 0) + 1;
  }
  let norm = 0;
  for (const v of Object.values(vec)) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (const k of Object.keys(vec)) vec[k] = Number((vec[k] / norm).toFixed(6));
  return vec;
}

function cosine(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  }
  const left = a || {};
  const right = b || {};
  let s = 0;
  const small = Object.keys(left).length <= Object.keys(right).length ? left : right;
  const large = small === left ? right : left;
  for (const [k, v] of Object.entries(small)) s += v * (large[k] || 0);
  return s;
}

function bm25Score(queryTerms, doc, stats) {
  if (!queryTerms.length || !doc.termFreq) return 0;
  const dl = doc.docLength || 1;
  const avgdl = stats.avgDocLength || 1;
  let score = 0;
  for (const term of queryTerms) {
    const tf = doc.termFreq[term] || 0;
    if (!tf) continue;
    const df = stats.df.get(term) || 0;
    const idf = Math.log(1 + (stats.totalDocs - df + 0.5) / (df + 0.5));
    score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl))));
  }
  return score;
}

class RagIndexStore {
  constructor(options = {}) {
    this.path = options.path || path.join(process.cwd(), '.smallcode', 'rag', 'index.json');
    this.docs = [];
    this._stats = null;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8'));
      this.docs = Array.isArray(raw.docs) ? raw.docs : [];
      this._stats = null;
    } catch {
      this.docs = [];
      this._stats = null;
    }
    return this.docs.length;
  }

  save() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify({ version: 2, dims: DIMS, scoring: 'hybrid-bm25-hash-vector', docs: this.docs }, null, 2));
  }

  _prepare(snippet) {
    const code = snippet.code || snippet.content || '';
    const searchable = [snippet.repoName, snippet.repo, snippet.path, snippet.lang, snippet.symbol, ...(snippet.tags || []), code].filter(Boolean).join('\n');
    const tokens = tokenize(searchable);
    return {
      ...snippet,
      code,
      termFreq: termFrequency(tokens),
      docLength: tokens.length,
      embedding: embed(searchable),
    };
  }

  upsertMany(snippets) {
    const byId = new Map(this.docs.map(d => [d.id, d]));
    for (const s of snippets) byId.set(s.id, this._prepare(s));
    this.docs = [...byId.values()];
    this._stats = null;
    return this.docs.length;
  }

  _buildStats(queryTerms = []) {
    const df = new Map(queryTerms.map(t => [t, 0]));
    let totalLen = 0;
    for (const d of this.docs) {
      totalLen += d.docLength || 0;
      if (!d.termFreq) continue;
      for (const t of queryTerms) if (d.termFreq[t]) df.set(t, (df.get(t) || 0) + 1);
    }
    return { df, totalDocs: this.docs.length || 1, avgDocLength: totalLen / (this.docs.length || 1) || 1 };
  }

  search(query, limit = 8, options = {}) {
    if (!this.docs.length) return [];
    const queryTerms = [...new Set(tokenize(query))];
    const queryEmbedding = embed(query);
    const stats = this._buildStats(queryTerms);
    const vectorWeight = options.vectorWeight ?? 0.75;
    return this.docs
      .map(d => {
        const bm25 = bm25Score(queryTerms, d, stats);
        const vector = cosine(queryEmbedding, d.embedding || {});
        return { ...d, bm25Score: bm25, vectorScore: vector, score: bm25 + vectorWeight * vector };
      })
      .filter(d => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'your', 'you', 'are', 'was', 'were',
  'will', 'would', 'could', 'should', 'have', 'has', 'had', 'not', 'but', 'what', 'when', 'where',
  'why', 'how', 'can', 'need', 'make', 'create', 'add', 'fix', 'code', 'file', 'class', 'function',
]);

module.exports = { RagIndexStore, tokenize, embed, cosine, bm25Score };
