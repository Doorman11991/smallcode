// SmallCode — Skill System
// Skills are reusable prompt templates that teach the model specific behaviors.
// They're simpler than plugins — just markdown files with frontmatter.
//
// Skill locations:
//   .smallcode/skills/   — project-level
//   ~/.config/smallcode/skills/  — user-level (global)
//   <package>/skills/    — bundled defaults (lowest priority)
//
// Skill format (markdown with YAML frontmatter):
// ---
// name: code-review
// trigger: manual          # "manual" (via /skill), "auto" (always injected), "match" (keyword match)
// keywords: [review, pr, quality]
// ---
// When reviewing code, follow these guidelines:
// 1. Check for security issues first
// 2. Then correctness
// 3. Then style
//
// Commands:
//   /skill list          — show all available skills
//   /skill add <name>    — create a new skill interactively
//   /skill use <name>    — inject a skill into the current conversation
//   /skill edit <name>   — edit an existing skill
//   /skill remove <name> — delete a skill

const fs = require('fs');
const path = require('path');
const os = require('os');

class SkillManager {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this.skills = new Map(); // name → skill object
    this._load();
  }

  _getSkillDirs() {
    return [
      path.join(this.projectDir, '.smallcode', 'skills'),
      path.join(os.homedir(), '.config', 'smallcode', 'skills'),
      path.join(__dirname, '..', '..', 'skills'),
    ];
  }

  _load() {
    for (const dir of this._getSkillDirs()) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const skill = this._parse(content, file, dir);
        if (skill) {
          this.skills.set(skill.name, skill);
        }
      }
    }
  }

  _parse(content, filename, dir) {
    // Parse YAML frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      // No frontmatter — not a skill (could be a README or doc file)
      return null;
    }

    const frontmatter = fmMatch[1];
    const body = fmMatch[2].trim();

    // Simple YAML parsing (no dep needed)
    const meta = {};
    for (const line of frontmatter.split('\n')) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        let value = match[2].trim();
        // Parse arrays: [a, b, c]
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, ''));
        }
        meta[match[1]] = value;
      }
    }

    return {
      name: meta.name || filename.replace('.md', ''),
      trigger: meta.trigger || 'manual',
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      content: body,
      path: path.join(dir, filename),
    };
  }

  // Get all skills
  list() {
    return [...this.skills.values()].map(s => ({
      name: s.name,
      trigger: s.trigger,
      keywords: s.keywords,
      preview: s.content.slice(0, 80) + (s.content.length > 80 ? '...' : ''),
    }));
  }

  // Get a skill by name
  get(name) {
    return this.skills.get(name) || null;
  }

  // Get skills that should auto-inject for a given message
  getAutoSkills(message) {
    const msg = message.toLowerCase();
    const results = [];
    for (const skill of this.skills.values()) {
      if (skill.trigger === 'auto') {
        results.push(skill);
      } else if (skill.trigger === 'match' && skill.keywords.length > 0) {
        const match = skill.keywords.some(kw => msg.includes(kw.toLowerCase()));
        if (match) results.push(skill);
      }
    }
    return results;
  }

  // Create a new skill
  add(name, content, options = {}) {
    const dir = path.join(this.projectDir, '.smallcode', 'skills');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const trigger = options.trigger || 'manual';
    const keywords = options.keywords || [];

    const frontmatter = [
      '---',
      `name: ${name}`,
      `trigger: ${trigger}`,
      keywords.length ? `keywords: [${keywords.join(', ')}]` : null,
      '---',
    ].filter(Boolean).join('\n');

    const fullContent = `${frontmatter}\n${content}\n`;
    const filename = `${name.replace(/[^a-z0-9-_]/gi, '-')}.md`;
    const filePath = path.join(dir, filename);

    fs.writeFileSync(filePath, fullContent);

    const skill = {
      name,
      trigger,
      keywords,
      content,
      path: filePath,
    };
    this.skills.set(name, skill);
    return skill;
  }

  // Remove a skill
  remove(name) {
    const skill = this.skills.get(name);
    if (!skill) return false;
    if (fs.existsSync(skill.path)) {
      fs.unlinkSync(skill.path);
    }
    this.skills.delete(name);
    return true;
  }

  // Format skills for system prompt injection
  formatForPrompt(skills) {
    if (skills.length === 0) return '';
    return '\n\nActive skills:\n' + skills.map(s => `[${s.name}] ${s.content}`).join('\n\n');
  }
}

module.exports = { SkillManager };
