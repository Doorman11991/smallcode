'use strict';

const { RagIndexStore } = require('./index_store');

function planQuery(query) {
  const q = String(query || '').trim();
  const intent = /bug|error|fix|failing|stack/.test(q.toLowerCase()) ? 'debug' : 'implement';
  const focus = q.split(/\s+/).filter(w => w.length > 3).slice(0, 8);
  return { intent, focus };
}

function googleFallbackUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query + ' github code example')}`;
}

class RagRetriever {
  constructor(options = {}) {
    this.index = options.index || new RagIndexStore(options.store || {});
    this.maxLoops = options.maxLoops || 3;
    this.loaded = false;
  }

  load() {
    const count = this.index.load();
    this.loaded = true;
    return count;
  }

  ensureLoaded() {
    if (!this.loaded) return this.load();
    return this.index.docs.length;
  }

  retrieve(query, opts = {}) {
    this.ensureLoaded();
    const plan = planQuery(query);
    const loops = [];
    let hits = [];
    for (let i = 0; i < (opts.maxLoops || this.maxLoops); i++) {
      const subquery = i === 0 ? query : `${query} ${plan.focus.slice(0, i + 2).join(' ')}`;
      hits = this.index.search(subquery, opts.limit || 8);
      loops.push({ loop: i + 1, subquery, hitCount: hits.length, topScore: hits[0]?.score || 0 });
      if ((hits[0]?.score || 0) >= 0.3) break;
    }
    return {
      plan,
      loops,
      hits,
      stuck: (hits[0]?.score || 0) < 0.2,
      googleFallback: (hits[0]?.score || 0) < 0.2 ? googleFallbackUrl(query) : null,
    };
  }

  formatForPrompt(query, opts = {}) {
    if (process.env.SMALLCODE_RAG_DISABLE === 'true') return '';
    const result = this.retrieve(query, opts);
    if (!result.hits.length) return '';

    const maxChars = opts.maxChars || 6000;
    let used = 0;
    const parts = [];
    for (const hit of result.hits.slice(0, opts.limit || 6)) {
      const code = String(hit.code || '').slice(0, opts.snippetChars || 1200);
      const lang = String(hit.lang || '').replace(/[^a-z0-9+#-]/gi, '');
      const scoreBits = [`score=${hit.score.toFixed(3)}`];
      if (typeof hit.bm25Score === 'number') scoreBits.push(`bm25=${hit.bm25Score.toFixed(3)}`);
      if (typeof hit.vectorScore === 'number') scoreBits.push(`vector=${hit.vectorScore.toFixed(3)}`);
      const symbol = hit.symbol ? ` ${hit.symbol}` : '';
      const header = `### ${hit.repo || 'local'}:${hit.path}:${hit.startLine || 1}${symbol} ${scoreBits.join(' ')}`;
      const block = `${header}\n` + '```' + `${lang}\n${code}\n` + '```';
      if (used + block.length > maxChars) break;
      used += block.length;
      parts.push(block);
    }
    if (!parts.length) return '';

    const stuckHint = result.stuck && process.env.SMALLCODE_WEB_BROWSE === 'true'
      ? `\nRAG confidence is low. If blocked, use web_search with: ${query} github code example`
      : '';
    return `\n[RAG_CODE_CONTEXT] Retrieved similar code snippets using hybrid BM25 + local hashed-vector search. Use these as examples, not as authoritative project files.${stuckHint}\n${parts.join('\n\n')}\n[/RAG_CODE_CONTEXT]\n`;
  }
}

module.exports = { RagRetriever, planQuery, googleFallbackUrl };
