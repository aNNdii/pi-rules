# pi-rules: rule loading from .agents, .pi and .claude

Date: 2026-10-09
Status: approved design, awaiting spec review

## Purpose

A pi extension that loads rule files the way pi-code's claude-rules extension does
(`ilovepixelart/pi-code@2efd7c6921f80ef7d31e8adf3cce828fac082998`, `extensions/claude-rules.ts`),
but from three directory kinds instead of one: `.agents/rules`, `.pi/rules` and `.claude/rules`.

The extension is the reference implementation. Friday (`ci/friday`, `packages/review/src/rule_file.py`)
follows it and implements the subset it needs (`<repo-root>/.agents/rules`). The dependency runs in one
direction only: pi-rules knows nothing about Friday and is not restricted by what Friday can do. The
extension must work in any project, including third-party projects that only ship `.claude/rules` or
nested rule directories.

## Non-goals

- Replacing pi-code as a whole. pi-rules only loads rules.
- Claude Code specifics that pi-code carries: `claudeMdExcludes`, managed settings, the
  `instruction-events` hook bus, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CONFIG_DIR`.
- A custom trust dialog or trust store entries.
- Automatic synchronisation with pi-code. Pulling in later pi-code changes is a deliberate manual change.
- Changes to Friday. Repointing Friday to pi-rules is a separate, later change (see "Friday").
- Deduplicating rules that exist in more than one source.

## Package

- Location: `/workspace/pi-rules` (`github.com/aNNdii/pi-rules`), installed in pi as
  `git:github.com/aNNdii/pi-rules`.
- TypeScript, ESM, loaded by pi directly from source via `"pi": { "extensions": ["./extensions/rules.ts"] }`
  in `package.json`.
- pnpm with a pinned `packageManager`; Node >= 22.19. Node and pnpm are provided by a `mise.toml`
  in the repository; no additional task runner.
- `peerDependencies`: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-agent-core` (`*`);
  the same as `devDependencies` (`^1.1.0`) for types and tests.
- Scripts: `test` (vitest), `type:check` (`tsc --noEmit`), `lint` (biome), `check` (all three).
- biome configuration taken from pi-code, so copied files stay byte-identical after formatting.
- The README states that pi-code must not be active at the same time, otherwise `.claude/rules`
  is loaded twice.

### Files

| File | Content |
| --- | --- |
| `extensions/rules.ts` | The extension: connects pi's events to the modules below, trust decision, notifications. Re-exports only `parseFrontmatter`. |
| `extensions/internal/sources.ts` | Where rules are: the six source directories, the upward search bounded by the repository root, directory dedup, glob bases and pointer bases. |
| `extensions/internal/rule-files.ts` | What rules say: frontmatter parsing, Markdown discovery and rule reading, taken over from pi-code's `extensions/claude-rules.ts`. |
| `extensions/internal/prompt.ts` | The system prompt: context files, pointer and section text, and the whole `before_agent_start` handling (`applyRules`), taken over from pi-code's `extensions/claude-rules.ts`. |
| `extensions/internal/attach.ts` | The tool results: `PendingRules`, the path-scoped rules still waiting to attach, with matching and re-arming. |
| `extensions/internal/path-rules.ts` | Glob compilation and matching. Copied unchanged from pi-code. |
| `extensions/internal/strip-comments.ts` | Block comment stripping. Copied unchanged from pi-code. |
| `extensions/internal/tool-target.ts` | Which file a read/edit/write call touched, normalised as pi resolves it. Copied unchanged from pi-code. |
| `extensions/internal/values.ts` | `escapeRegExp` and `realpathOr`, copied from pi-code's `extensions/internal/values.ts`, plus the own `relativeWithin`. |

Copied files keep their export names and their paths relative to `extensions/`, so Friday's
`packages/review/tests/plugin_vectors.mjs` only has to change the repository and the name of the
extension file (`claude-rules.ts` → `rules.ts`). Each copied file starts with a provenance note
(source repository, commit, original path, MIT licence); pi-code's MIT licence text is kept in
`LICENSES/pi-code.txt`.

The parts of `extensions/rules.ts`, `extensions/internal/rule-files.ts`, `extensions/internal/prompt.ts` and `extensions/internal/attach.ts` that pi-code has in `extensions/claude-rules.ts` (frontmatter
parsing, Markdown discovery, rule reading, pointer and section text, prompt options handling, the
attach loop) are taken over with the same behaviour, regrouped so that each module owns one concern.
Source discovery, trust handling, the report of unreadable rules and the removed Claude-specific
features differ.

## Sources

Loaded in this order; rules from all sources are loaded, including rules with the same relative path
in different sources (no deduplication):

| # | Scope | Directory | Glob base |
| --- | --- | --- | --- |
| 1 | global | `~/.agents/rules` | session cwd |
| 2 | global | `<agentDir>/rules` (default `~/.pi/agent/rules`, honours `PI_CODING_AGENT_DIR` via `getAgentDir()`) | session cwd |
| 3 | global | `~/.claude/rules` | session cwd |
| 4 | project | nearest `.agents/rules` | parent of `.agents/` |
| 5 | project | nearest `.pi/rules` | parent of `.pi/` |
| 6 | project | nearest `.claude/rules` | parent of `.claude/` |

- Within a source, files are sorted by relative path with `localeCompare(…, 'en')`, as in pi-code.
- "Nearest" means: for each kind independently, the first existing directory found walking from the
  session cwd upwards, stopping at the repository root (the nearest ancestor-or-self directory that
  contains a `.git` file or directory). Outside a repository only the cwd itself is checked.
- A directory that resolves (realpath) to the same location as an earlier source is skipped: a session
  started in `$HOME`, where the nearest `.agents/rules` is `~/.agents/rules`, or `~/.claude/rules`
  symlinked to `~/.agents/rules`. The "no deduplication" rule is about rule files, not directories.
- A missing directory is an empty source.

## Reading rule files

As in pi-code:

- Every `.md` file under a source directory, recursively. Symbolic links (files and directories) are
  followed; a visited set of real paths prevents cycles; a dangling link is skipped.
- Frontmatter (`---` … `---`, optional BOM) is split off; `paths:` accepts a scalar, a flow sequence
  (possibly spanning lines, brace groups and quotes kept intact) or a block sequence.
- The body gets `stripBlockComments` and is trimmed. A rule whose body is empty is skipped.
- A rule without `paths:` is an unscoped (always-applying) rule; one with `paths:` is a path-scoped rule.
- A missing directory is an empty source. A rule file or directory that exists but cannot be read is
  skipped and reported (see `session_start`); it never aborts session start.

Glob semantics are those of the copied `extensions/internal/path-rules.ts` (`*` within a segment, `**`
across segments, slashless pattern = base directory only, trailing slash = directory contents, leading
`./` and `/` stripped, brace expansion).

## Project trust

- Global sources always load.
- Project sources (4–6) load only if `ctx.isProjectTrusted()` returns `true`. If it returns `false`
  or the function is missing, all three project sources are skipped and a notice is shown
  (`Project rules skipped: project is not trusted`), only if at least one project rule directory exists.
- No own dialog and no writes to `~/.pi/agent/trust.json`. Rationale: rules are prompt text like
  `AGENTS.md`, which pi loads regardless of trust (pi `docs/security.md`); a "no" from pi is still
  respected. pi 1.1 reports a project without pi-guarded resources (`.pi/settings.json`, `.pi/extensions`,
  `.agents/skills`, …) as trusted, so a repository with only rule directories loads its rules; the
  README says so.

## Lifecycle

### `session_start`

1. Resolve the six source directories and the trust decision.
2. Read the rules of every source that loads.
3. Build:
   - the context files: one `{ path: <absolute rule file>, content: <body> }` per unscoped rule,
     in source order;
   - the pointer text for path-scoped rules, one block per source:
     `Path-scoped rules, available in <base>/:` followed by `- <base>/<rel> — applies when working on: <globs>`
     lines and the instruction to read the rule before working on matching files. `<base>` is
     `~/…` for directories under home and relative to the cwd for project directories (falling
     back to the absolute path), so the model's read resolves;
   - the fallback text: `## Global Rules` and `## Project Rules` sections with the unscoped bodies and
     pointers, as in pi-code's `rulesSection`;
   - the pending rules (`PendingRules`): one entry per path-scoped rule with its compiled globs, body
     and the realpath of its glob base.
4. Notify `Rules loaded: global <n>, project <m>` (`info`) when at least one rule was loaded, and
   `Rules skipped, cannot read: <absolute paths, comma-separated>` (`warning`) when a rule file or
   directory could not be read. A dangling symlink is not reported.

### `before_agent_start`

Identical to pi-code: if `event.systemPromptOptions.contextFiles` exists, push copies of the context
files and append the pointers to `appendSystemPrompt`. If pi re-rendered `event.systemPrompt` from
the options, return nothing. Otherwise undo the edit (unless `forceSystemPrompt` is set) and return
`{ systemPrompt: before + fallbackText }`.

### `tool_result`

- Determine the touched file with `fileToolTarget` (only `read`, `edit`, `write`; not on error).
- Resolve it against `ctx.cwd` and take its realpath.
- For each pending attach target whose base contains the file and whose globs match the path
  relative to the base: append the body as an additional text block to the tool result and remove the
  target from the pending list. Each rule attaches at most once until re-armed.

### `session_compact`, `session_tree`

Re-arm: the pending list is reset to all path-scoped rules of the session.

## Testing

vitest, with temporary directories for home, repository and cwd, `HOME` and `PI_CODING_AGENT_DIR`
pointed at them, and a minimal fake of `ExtensionAPI` and `ctx` that records handlers, notifications
and returns.

- Copied modules: the matching tests from pi-code (`tests/path-rules.test.ts`; the frontmatter and
  comment cases from `tests/claude-rules.test.ts`), adapted only in import paths.
- Extension:
  - all six sources load in the specified order; a rule present in two sources appears twice;
  - nearest project directory per kind, walk stops at the repository root, outside a repository only
    the cwd is checked; glob bases per kind;
  - a project directory equal to a global one is skipped;
  - `isProjectTrusted() === false`: only global rules load, notice shown;
  - unreadable rule files and directories are skipped and reported;
  - context files, pointers in `appendSystemPrompt`, fallback text when pi does not re-render,
    behaviour with `forceSystemPrompt`;
  - lazy attach: matching file attaches once, non-matching and outside-base files do not, errored
    calls do not, re-arm after `session_compact` and `session_tree`;
  - error paths: unreadable file, empty body, symlink cycle, dangling link.

`pnpm check` must pass.

## Friday

Out of scope for this change; listed so the follow-up is clear:

- `packages/review/tests/plugin_vectors.mjs` loads `rules.ts` from a pi-rules checkout.
- The pinned commit in `packages/review/src/rule_file.py` (`PLUGIN`) points to pi-rules.
- `packages/review/tests/plugin_vectors.json` is regenerated.
- `README.md`, `packages/review/README.md` and `CHANGELOG.md` reference pi-rules instead of pi-code.

The pi-rules README states that Friday only reads `<repo-root>/.agents/rules`, so rules meant to apply
in review belong there.
