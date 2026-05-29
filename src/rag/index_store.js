'use strict';

const fs = require('fs');
const path = require('path');

const DIMS = parseInt(process.env.SMALLCODE_RAG_DIMS || '512', 10);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_#]+/)
    .filter(t => t.length >= 2);
}

function hashToken(token, dims = DIMS) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % dims;
}

function embed(text, dims = DIMS) {
  const vec = new Float32Array(dims);
  const toks = tokenize(text);
  for (const t of toks) vec[hashToken(t, dims)] += 1;
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return Array.from(vec);
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

class RagIndexStore {
  constructor(options = {}) {
    this.path = options.path || path.join(process.cwd(), '.smallcode', 'rag', 'index.json');
    this.docs = [];
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8'));
      this.docs = Array.isArray(raw.docs) ? raw.docs : [];
    } catch {
      this.docs = [];
    }
    return this.docs.length;
  }

  save() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify({ version: 1, dims: DIMS, docs: this.docs }, null, 2));
  }

  upsertMany(snippets) {
    const byId = new Map(this.docs.map(d => [d.id, d]));
    for (const s of snippets) {
      byId.set(s.id, { ...s, embedding: embed(`${s.path}\n${s.code}`) });
    }
    this.docs = [...byId.values()];
    return this.docs.length;
  }

  search(query, limit = 8) {
    if (!this.docs.length) return [];
    const q = embed(query);
    return this.docs
      .map(d => ({ ...d, score: cosine(q, d.embedding || []) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

module.exports = { RagIndexStore, tokenize, embed, cosine };
