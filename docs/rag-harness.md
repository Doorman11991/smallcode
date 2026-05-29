# RAG Coding Harness Guide

This repo runs as a terminal UI coding harness. The default interface is the fullscreen TUI; use `--classic` if your terminal does not support alternate-screen rendering.

## 0. From a fresh GitHub clone

If you just downloaded or pulled the repo, you do **not** need to publish/install anything first. Run it from the checkout:

```bash
cd smallcode
npm install
node bin/smallcode.js --help
```

Then start a local model server and create a `.env` file in the directory where you will run the harness. For testing against LM Studio's default local server this usually looks like:

```bash
cat > .env <<'ENV'
SMALLCODE_MODEL=your-loaded-model-name
SMALLCODE_BASE_URL=http://localhost:1234/v1
ENV
```

Start the UI from the checkout with:

```bash
node bin/smallcode.js
```

If you want the normal `smallcode` command instead of typing `node bin/smallcode.js`, link the checkout once:

```bash
npm link
smallcode
```

Use `node bin/smallcode.js --classic` or `smallcode --classic` if your terminal has trouble with the fullscreen interface.

## 1. Start a local model server

SmallCode talks to any OpenAI-compatible local endpoint.

### LM Studio

1. Open LM Studio.
2. Download/load a coder model such as Qwen Coder or another 8B-35B local coding model.
3. Start the **Local Server**.
4. Note the model name shown by LM Studio and the base URL, usually `http://localhost:1234/v1`.

Create `.env` in the project you want to edit:

```bash
SMALLCODE_MODEL=your-loaded-model-name
SMALLCODE_BASE_URL=http://localhost:1234/v1
```

### llama.cpp server

Start llama.cpp with its OpenAI-compatible server, then point SmallCode at it:

```bash
SMALLCODE_MODEL=local-model
SMALLCODE_BASE_URL=http://localhost:8080/v1
```

## 2. Run the UI harness

From the project directory you want the agent to edit:

```bash
smallcode
```

If you are developing from this repository checkout instead of a global install:

```bash
node bin/smallcode.js
```

Useful launch modes:

```bash
smallcode --classic                    # readline UI instead of fullscreen UI
smallcode -P "fix the parser bug"      # one-shot prompt
smallcode --non-interactive "refactor" # stdin/script friendly mode
smallcode --resume                     # continue previous session
```

Inside the UI:

- Type your task and press Enter.
- Use `/help` for commands.
- Use `/plan` to inspect the active plan.
- Use `/undo` to revert the last edit.
- Use `/quit` to exit.

## 3. Create the local GitHub RAG database

The scraper is a Python pipeline at `scripts/rag_scraper.py`. It shallow-clones or updates repositories, walks source files, and emits **snippet-sized chunks** around functions/classes/types plus sliding-window chunks for files without clear symbols. It does not index whole files as a single blob.

### Fast starter corpus

If you do not create a config file, the indexer uses the built-in `starter` preset: a curated multi-language set of popular frameworks/libraries across Python, JavaScript/TypeScript, Go, Rust, Java, C#, Ruby, PHP, and C/C++.

```bash
npm run rag:index
```

### Larger broad corpus

For a bigger language-modeling corpus, use the `broad` preset. This scrapes more well-known, high-signal codebases, but takes longer and uses more disk space.

```bash
npm run rag:index -- --preset broad
```

The curated presets live in `src/rag/curated_repos.json`, so you can review or change the selected repositories.

### Custom corpus

Create `.smallcode/rag/repos.json` in the workspace where you run SmallCode:

```json
{
  "preset": "starter",
  "repos": [
    "https://github.com/owner/framework-example.git",
    "https://github.com/owner/language-examples.git",
    { "url": "/absolute/path/to/local/repo", "tags": ["local", "examples"] }
  ],
  "maxFilesPerRepo": 1000,
  "maxSnippetsPerRepo": 4000,
  "chunkLines": 80,
  "overlap": 20
}
```

Set `"preset": "none"` if you only want your own repos.

Optional fields:

```json
{
  "cacheDir": ".smallcode/rag/repos",
  "indexPath": ".smallcode/rag/index.json",
  "languages": ["python", "typescript", "go"],
  "maxFileBytes": 250000,
  "minChars": 120,
  "repos": ["https://github.com/owner/repo.git"]
}
```

After package installation, the same command is also available as:

```bash
smallcode-rag-index --preset broad
```

The indexer saves `.smallcode/rag/index.json` by default.

## 4. How code search works

SmallCode searches **code snippets**, not full files. The pipeline stores each snippet with repo, language, path, symbol name, start/end lines, tags, term frequencies, and a sparse local hashed vector.

At query time the retriever runs a hybrid search:

1. **BM25 lexical search** over identifiers, paths, symbols, tags, and snippet text. This is strong for exact APIs, framework names, error names, and language constructs.
2. **Local hashed-vector similarity** over the same snippet text. This is dependency-free and helps related naming patterns match even when exact words differ.
3. The final rank combines BM25 and vector scores, then injects only the top bounded snippets into model context.

This approach is intentionally fast enough for local models and large local corpora without requiring a separate vector database or cloud embeddings.

## 5. Use RAG in the harness

Once `.smallcode/rag/index.json` exists, start the UI normally:

```bash
smallcode
```

For each user turn, SmallCode now:

1. plans/classifies the request,
2. retrieves similar snippets from the local RAG index,
3. injects the best snippets into the model context,
4. asks the local model to do one step at a time through the normal tool loop.

No cloud embedding service is required. The default embedding path is dependency-free and optimized for fast local startup.

## 6. Optional web fallback when RAG is weak

Web search is disabled by default. Enable it only when you want the model to search externally after local RAG confidence is low:

```bash
SMALLCODE_WEB_BROWSE=true smallcode
```

When enabled, low-confidence RAG context tells the model to use `web_search` with a GitHub/code-example query if it gets blocked.

## 7. Speed tips for local models

- Prefer the fullscreen UI (`smallcode`) for normal work; use `--classic` only for terminal compatibility issues.
- Keep `SMALLCODE_CACHE_SPLIT` at its default (`true`) so llama.cpp-style KV cache reuse is not invalidated by dynamic context.
- Keep RAG repos focused when you need fast indexing; use `--preset broad` when you intentionally want a large reference corpus.
- Use 8B-35B coder models; very small models often fail multi-step tool use.
- If the model struggles, ask for a smaller concrete task first, then continue with follow-up prompts.
