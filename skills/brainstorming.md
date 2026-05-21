---
name: brainstorming
trigger: match
keywords: [design, feature, approach, plan, brainstorm, architecture]
---

# Brainstorming

Use BEFORE implementing. Prevents building the wrong thing on small models that rush to code.

## Steps

1. **Search first** — call `memory_load` with the task topic, then `search` or `find_files` for relevant code. Never brainstorm in a vacuum.
2. **State the problem** — one sentence. What are we actually solving?
3. **Three approaches** — for each: name it, state the core tradeoff in one sentence.
4. **Recommend one** — which and why in two sentences.
5. **Flag constraints** — auth, migrations, external APIs, config, hooks? Note gotchas.
6. **Stop** — do not implement until the user confirms the approach.

## Rules

- Context search first. Three approaches minimum.
- Step 6 is not optional. "I'll just start" skips the whole point.
- If the user rejects all three, ask what's missing before generating more.
