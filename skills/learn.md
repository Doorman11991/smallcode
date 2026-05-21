---
name: learn
trigger: manual
keywords: [learn, pattern, remember, gotcha]
---

# Learn — Extract a Reusable Pattern

Use when something non-obvious was discovered: a workaround, invariant, library quirk, or integration pattern.

## What to learn

- Operational constraints, version-specific fixes, architecture gotchas
- Test commands or build quirks not obvious from code

## What NOT to learn

- Code patterns derivable by reading the repo
- Task state or in-progress work from this session
- Anything already in README or comments

## Steps

1. **Name the pattern** — one short title.
2. **Search memory** — `memory_load` for similar titles. Update instead of duplicating.
3. **Save** — `memory_remember` with the right type:
   - `decision` — ratified choice future sessions must respect
   - `workflow` — repeatable procedure (build, test, deploy)
   - `gotcha` — trap and workaround
   - `convention` — naming, style, architecture pattern
   - `context` — domain knowledge, feature map
4. **Confirm** — report what was saved and why it matters next session.

## Rule

One pattern per remember call. Keep content under 200 words — small models retrieve better with focused notes.
