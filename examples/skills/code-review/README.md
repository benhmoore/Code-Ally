# Example Code Review Skill

A practical skill demonstrating the Agent Skills format. This skill provides a systematic code review workflow.

## Files

- `SKILL.md` — Skill definition (YAML frontmatter + instructions)

## Installation

### Project-level (recommended)

Install in your repository so the skill is available for that project:

```bash
mkdir -p .github/skills
cp -r examples/skills/code-review .github/skills/
```

Or use the Ally-specific location:

```bash
mkdir -p .ally/skills
cp -r examples/skills/code-review .ally/skills/
```

### User-level

Install globally so the skill is available in all projects:

```bash
mkdir -p ~/.ally/skills
cp -r examples/skills/code-review ~/.ally/skills/
```

## Usage

Once installed, the skill is automatically available. You can:

**List skills:**
```
/skill list
```

**View skill details:**
```
/skill show code-review
```

**Use the skill:**
Simply ask Ally to review code — the skill instructions will be loaded automatically when relevant, or you can explicitly request it:

> "Review the authentication module using the code-review skill"

## SKILL.md Format

Skills use a simple format:

```markdown
---
name: skill-name
description: What the skill does and when to use it.
---

# Skill Instructions

Your detailed instructions here...
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier (kebab-case, max 64 chars) |
| `description` | Yes | When to use this skill (max 1024 chars) |

### Body

The body contains the detailed instructions the AI will follow. Write clear, specific guidance including:

- Step-by-step procedures
- Output format expectations
- Examples when helpful
- Guidelines and best practices

## Skill Locations

Skills are discovered from these locations (in priority order):

| Location | Scope | Priority |
|----------|-------|----------|
| `.github/skills/` | Project | Highest |
| `.claude/skills/` | Project | High |
| `.ally/skills/` | Project | High |
| `~/.ally/skills/` | User | Lower |
| Plugin skills | Plugin | Lowest |

Project skills override user skills with the same name.

## Creating Your Own Skills

1. Create a directory for your skill
2. Add a `SKILL.md` file with frontmatter and instructions
3. Optionally add supporting files (templates, examples, scripts)
4. Install to one of the skill locations

See this example as a reference for the format and structure.
