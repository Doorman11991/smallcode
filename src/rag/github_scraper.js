'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const CODE_EXTS = new Set(['.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.cs', '.php', '.rb']);

function runGit(args, cwd) {
  cp.execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function ensureRepo(url, targetDir) {
  const name = url.replace(/\.git$/, '').split('/').slice(-2).join('__');
  const out = path.join(targetDir, name);
  if (fs.existsSync(path.join(out, '.git'))) runGit(['pull', '--ff-only'], out);
  else runGit(['clone', '--depth=1', url, out], targetDir);
  return out;
}

function* walk(dir) {
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of list) {
    if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(full);
    else if (ent.isFile()) yield full;
  }
}

function chunkCode(text, chunkLines = 60, overlap = 15) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += (chunkLines - overlap)) {
    const piece = lines.slice(i, i + chunkLines).join('\n').trim();
    if (piece.length >= 80) out.push({ startLine: i + 1, code: piece });
  }
  return out;
}

function collectSnippets(repoRoot, sourceUrl) {
  const snippets = [];
  for (const file of walk(repoRoot)) {
    const ext = path.extname(file).toLowerCase();
    if (!CODE_EXTS.has(ext)) continue;
    const rel = path.relative(repoRoot, file);
    const body = fs.readFileSync(file, 'utf-8');
    for (const c of chunkCode(body)) {
      const id = crypto.createHash('sha1').update(`${sourceUrl}:${rel}:${c.startLine}:${c.code}`).digest('hex');
      snippets.push({ id, repo: sourceUrl, path: rel, startLine: c.startLine, code: c.code, lang: ext.slice(1) });
    }
  }
  return snippets;
}

module.exports = { ensureRepo, collectSnippets, chunkCode };
