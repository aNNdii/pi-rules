# pi-rules

A pi extension that loads rule files from `.agents/rules`, `.pi/rules` and `.claude/rules`, globally and per project, the way Claude Code loads `.claude/rules`.

- Rules without `paths:` frontmatter always apply. They join the system prompt as context files, one per rule file.
- Rules with `paths:` frontmatter are path-scoped. The system prompt lists them as pointers, and when a `read`, `edit` or `write` touches a file their globs cover, the rule body is appended to that tool's result. Each rule attaches once; after a compaction or `/tree` it can attach again.

## Install

```sh
pi install git:github.com/aNNdii/pi-rules
```

Do not enable pi-code's claude-rules extension at the same time, or `.claude/rules` loads twice.

## Sources

All sources load, in this order. A rule present in more than one source loads once per source.

| # | Scope | Directory | `paths:` globs are relative to |
| --- | --- | --- | --- |
| 1 | global | `~/.agents/rules` | the session's working directory |
| 2 | global | `<agentDir>/rules` (`~/.pi/agent/rules`, or under `PI_CODING_AGENT_DIR`) | the session's working directory |
| 3 | global | `~/.claude/rules` | the session's working directory |
| 4 | project | nearest `.agents/rules` | the directory holding `.agents/` |
| 5 | project | nearest `.pi/rules` | the directory holding `.pi/` |
| 6 | project | nearest `.claude/rules` | the directory holding `.claude/` |

- "Nearest" is searched separately for each kind: the first existing directory from the working directory upwards, stopping at the repository root (the nearest directory containing `.git`, a directory or a worktree's file). Outside a repository only the working directory itself is checked.
- A directory that is the same location as an earlier one is loaded only once: a session in `$HOME`, or `~/.claude/rules` symlinked to `~/.agents/rules` to share rules with Claude Code.
- Every `.md` file below a rules directory is a rule, recursively and following symbolic links. Files are ordered by name. Block comments (`<!-- … -->`) outside code fences are removed; a rule whose body is then empty is skipped.
- A rule file or directory that exists but cannot be read is skipped, and pi shows a warning naming it.

## Rule files

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "**/*.{test,spec}.ts"
---
Validate every request body at the handler boundary.
```

`paths:` takes a single glob, a flow list (`["a/**", "b/**"]`) or a block list. `*` stays within a path segment, `**` crosses segments, `{a,b}` and `[abc]` expand. A slashless glob (`*.md`) matches only at the glob base; write `**/*.md` for any depth. A trailing slash (`docs/`) means everything below that directory.

## Project trust

Global rules always load. Project rules load unless pi reports the project as not trusted (`ctx.isProjectTrusted()`); then all project rules are skipped and a warning is shown. pi-rules has no trust dialog of its own: pi loads `AGENTS.md` and `CLAUDE.md` regardless of trust, and rules are the same kind of prompt text.

This is not a gate for unvetted repositories. pi only asks about trust when a project has resources pi itself guards (`.pi/settings.json`, `.pi/extensions`, `.agents/skills` and similar); rule directories are not among them. A repository with nothing but rule directories therefore counts as trusted, even if you declined it earlier, and its rules load. Project rules are skipped only when pi actually decided against the project, for example after you declined it in a repository with such resources, or with `--no-approve`. Review the rules of a repository you do not trust like you would review its `AGENTS.md`.

## Friday

The Friday reviewer reads only `<repo-root>/.agents/rules` from the default branch. Put rules that must apply in review there.

## Provenance

pi-rules is derived from [pi-code](https://github.com/ilovepixelart/pi-code) at commit `2efd7c6921f80ef7d31e8adf3cce828fac082998` (MIT, `LICENSES/pi-code.txt`):

- copied unchanged: `extensions/internal/path-rules.ts`, `extensions/internal/strip-comments.ts`, `extensions/internal/tool-target.ts` and their tests;
- copied in part: `extensions/internal/values.ts` (`escapeRegExp`, `realpathOr`);
- adapted from pi-code's `extensions/claude-rules.ts`: `extensions/rules.ts`, `extensions/internal/rule-files.ts`, `extensions/internal/prompt.ts`, `extensions/internal/attach.ts`;
- adapted from pi-code's `extensions/internal/project-root.ts`: the upward search in `extensions/internal/sources.ts`.

Later pi-code changes are not synchronised automatically.

## Development

```sh
pnpm install
pnpm check   # biome, tsc --noEmit, vitest
```
