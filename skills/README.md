# Bundled Skills

Example skills for SmallCode, adapted from the [Willow 2.0](https://github.com/rudi193-cmd/willow-2.0) Fylgja dev-methodology pack. They teach budget-aware workflows tuned for 8B–35B local models.

## Install

Bundled skills load automatically — no setup needed.

**To customize a bundled skill**, copy it to your project or global directory. Project-level skills with the same name override the bundled version:

```bash
# Project override
mkdir -p .smallcode/skills
cp /path/to/smallcode/skills/debugging.md .smallcode/skills/

# Global override
mkdir -p ~/.config/smallcode/skills
cp /path/to/smallcode/skills/debugging.md ~/.config/smallcode/skills/
```

## Usage

| Skill | Trigger | Use when |
|-------|---------|----------|
| `brainstorming` | keyword match | Designing a feature or choosing an approach |
| `debugging` | keyword match | A bug, failing test, or unexpected behavior |
| `tdd` | keyword match | Implementing new logic with tests first |
| `iterative-retrieval` | keyword match | Need context before reading files |
| `learn` | manual (`/skill use learn`) | A non-obvious pattern worth persisting |
| `external-guard` | keyword match | Ingesting web fetches or other untrusted text |

```bash
/skill list
/skill use brainstorming
```

Project-level skills in `.smallcode/skills/` override bundled defaults with the same name.

## Source

Upstream: [willow/fylgja/skills](https://github.com/rudi193-cmd/willow-2.0/tree/master/willow/fylgja/skills) — Willow MCP tool names were mapped to SmallCode's `memory_load` / `memory_remember` / `search` tools.
