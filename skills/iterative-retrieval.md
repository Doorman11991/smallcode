---
name: iterative-retrieval
trigger: match
keywords: [search, context, find, where, lookup, remember]
---

# Iterative Retrieval

Use when you need context about a topic before reading files or writing code. Memory is the map; files are the territory.

## Retrieval ladder (stop when you have enough)

**Rung 1 — Project memory** (broadest):
Call `memory_load` with a short task description. Scan decisions, workflows, gotchas, conventions.

**Rung 2 — Code search**:
Call `search` (regex) or `graph_search` (symbols) for the topic. Read paths and snippets only.

**Rung 3 — Targeted read**:
Call `read_file` on one specific file — the section you need, not the whole repo.

**Rung 4 — Full file** (last resort):
Only if Rungs 1–3 returned nothing useful.

## Rule

Never skip to Rung 4. Small models burn context on full-file reads — climb the ladder instead.
