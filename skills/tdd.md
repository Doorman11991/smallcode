---
name: tdd
trigger: match
keywords: [test, tdd, implement, feature, bugfix]
---

# Test-Driven Development

Strict red/green/refactor for small models that over-implement.

## Cycle

1. **Write the failing test first.** Run it. Confirm it fails with the expected error — not a crash.
2. **Minimum code to pass.** No extra logic, no preemptive abstractions.
3. **Run the test.** Green → commit → next test. Red → fix only what the test says.

## Rules

- One behavior per test. Commit each green state.
- Never batch test + implementation into one commit.
- Bug fixes: write a regression test that fails on the old behavior, then fix.

## SmallCode tips

- Use `bash` to run the project's test runner (`npm test`, `pytest`, `cargo test`).
- After green, `memory_remember` type `workflow` if you discovered a project-specific test command or quirk.
