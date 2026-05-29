# RAG Coding Harness Guide

This repo runs as a terminal UI coding harness. The default interface is the fullscreen TUI; use `--classic` if your terminal does not support alternate-screen rendering.

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

Create `.smallcode/rag/repos.json` in the workspace where you run SmallCode:

```json
{
  "repos": [
    "https://github.com/owner/framework-example.git",
    "https://github.com/owner/language-examples.git"
  ]
}
```

Optional fields:

```json
{
  "cacheDir": ".smallcode/rag/repos",
  "indexPath": ".smallcode/rag/index.json",
  "repos": ["https://github.com/owner/repo.git"]
}
```

Build/update the index:

```bash
npm run rag:index
```

After package installation, the same command is also available as:

```bash
smallcode-rag-index
```

The indexer shallow-clones or fast-forwards each repo, chunks source files, computes lightweight local embeddings, and saves `.smallcode/rag/index.json`.

## 4. Use RAG in the harness

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

## 5. Optional web fallback when RAG is weak

Web search is disabled by default. Enable it only when you want the model to search externally after local RAG confidence is low:

```bash
SMALLCODE_WEB_BROWSE=true smallcode
```

When enabled, low-confidence RAG context tells the model to use `web_search` with a GitHub/code-example query if it gets blocked.

## 6. Speed tips for local models

- Prefer the fullscreen UI (`smallcode`) for normal work; use `--classic` only for terminal compatibility issues.
- Keep `SMALLCODE_CACHE_SPLIT` at its default (`true`) so llama.cpp-style KV cache reuse is not invalidated by dynamic context.
- Keep RAG repos focused: index examples for the frameworks/languages you actually use instead of huge monorepos.
- Use 8B-35B coder models; very small models often fail multi-step tool use.
- If the model struggles, ask for a smaller concrete task first, then continue with follow-up prompts.
