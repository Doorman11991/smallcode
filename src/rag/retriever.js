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
  }

  load() { return this.index.load(); }

  retrieve(query, opts = {}) {
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
}

module.exports = { RagRetriever, planQuery, googleFallbackUrl };
