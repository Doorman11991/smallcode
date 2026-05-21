---
name: debugging
trigger: match
keywords: [bug, fix, error, broken, fails, debug, crash]
---

# Debugging

Structured bug hunt. Prevents guessing and scope creep on small models.

## Steps

1. **Search prior context** — `memory_load` for the error or module, then `search` for the message.
2. **State the bug** — exact error, `file:line` if known, expected vs actual.
3. **Smallest reproduction** — minimum input that triggers this.
4. **Hypothesize** — 2–3 candidate causes, ranked by likelihood.
5. **Test top hypothesis** — read the relevant file/line. Confirm or eliminate.
6. **Surgical fix only** — no surrounding cleanup or refactors.
7. **Run the test** — confirm the fix. If no test exists, write one first.
8. **Remember gotchas** — if non-obvious, `memory_remember` type `gotcha`.

## Rules

- Never skip step 1. Never fix without a test.
- If you can't reproduce it in step 3, you don't understand it yet.
