import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { globCompileStats } from '../extensions/internal/path-rules.ts'
import rulesExtension from '../extensions/rules.ts'

// Wiring cases ported from ilovepixelart/pi-code@2efd7c6921f80ef7d31e8adf3cce828fac082998,
// tests/claude-rules.test.ts; the cases after them cover the sources pi-rules adds.

// Global rules load from the home directory; point it at a throwaway dir so the
// developer's real rules cannot influence assertions.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>

describe('extension wiring', () => {
  // pi's agent directory holds the <agentDir>/rules source; isolate it like home.
  let agentDir: string
  beforeEach(() => {
    hoisted.home = realpathSync(mkdtempSync(join(tmpdir(), 'rules-home-')))
    agentDir = realpathSync(mkdtempSync(join(tmpdir(), 'rules-agent-')))
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  })

  const projectWithRule = (rule: string): string => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'rules-')))
    mkdirSync(join(cwd, '.claude', 'rules'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'rules', 'testing.md'), rule)
    return cwd
  }

  /** How pi renders a context file into the prompt; only its presence matters here. */
  const instructionsBlock = (path: string, content: string): string => `<file ${path}>\n${content}`

  /** A before_agent_start event shaped like pi >= 0.86's: systemPrompt re-renders from the
   * mutable systemPromptOptions, so what a handler adds to them shows up in it. */
  const renderingEvent = (appendSystemPrompt = '') => {
    const systemPromptOptions = { contextFiles: [] as Array<{ path: string; content: string }>, appendSystemPrompt }
    return {
      systemPromptOptions,
      get systemPrompt(): string {
        const addendum = systemPromptOptions.appendSystemPrompt ? [systemPromptOptions.appendSystemPrompt] : []
        return ['BASE', ...addendum, ...systemPromptOptions.contextFiles.map((file) => instructionsBlock(file.path, file.content))].join('\n\n')
      },
    }
  }

  /** Wire the extension and expose its handlers so events can be fired. */
  const wire = () => {
    const handlers = new Map<string, Handler>()
    rulesExtension({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as never)
    return handlers
  }

  const sessionPrompt = async (context: Record<string, unknown>): Promise<string> => {
    const handlers = wire()
    await handlers.get('session_start')?.({}, context)
    const event = renderingEvent()
    const result = (await handlers.get('before_agent_start')?.(event, {})) as { systemPrompt: string } | undefined
    return result?.systemPrompt ?? event.systemPrompt
  }

  const ctx = (cwd: string, trusted = true) => ({ cwd, isProjectTrusted: () => trusted, hasUI: true, ui: { notify: vi.fn() } })

  const globalCtx = () => ctx(realpathSync(mkdtempSync(join(tmpdir(), 'rules-cwd-'))))

  const readResult = (relPath: string) => ({ toolName: 'read', input: { path: relPath }, content: [{ type: 'text', text: 'FILE BODY' }], isError: false })

  const injectedTexts = (result: unknown): string[] => ((result as { content?: Array<{ text?: string }> } | undefined)?.content ?? []).map((block) => block.text ?? '')

  it('attaches on the file_path spelling of the tool input as well as path', async () => {
    // pi's edit and write tools accept file_path as an alias; a model that uses it
    // would otherwise edit the file the rule governs and never see the rule.
    const cwd = projectWithRule('---\npaths:\n  - "db/**"\n---\nUse parameterized queries.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))

    const edited = await handlers.get('tool_result')?.({ toolName: 'edit', input: { file_path: 'db/schema.sql' }, content: [{ type: 'text', text: 'FILE BODY' }], isError: false }, { cwd })
    expect(injectedTexts(edited).join('\n')).toContain('Use parameterized queries.')
  })

  it('attaches a scoped project rule when a matching file is touched, once per session', async () => {
    const cwd = projectWithRule('---\npaths:\n  - "db/**"\n---\nUse parameterized queries.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))

    const first = await handlers.get('tool_result')?.(readResult('db/schema.sql'), { cwd })
    expect(injectedTexts(first).join('\n')).toContain('Use parameterized queries.')
    // The file body is preserved; the rule is appended after it.
    expect(injectedTexts(first)).toContain('FILE BODY')

    // A second touch of a matching file does not re-attach the same rule.
    const second = await handlers.get('tool_result')?.(readResult('db/other.sql'), { cwd })
    expect(injectedTexts(second).join('\n')).not.toContain('Use parameterized queries.')
  })

  // Claude: after /compact, "rules with paths: frontmatter reload as Claude reads files they
  // apply to". The attached body sits in a tool result that compaction folds into a summary
  // and that /tree leaves behind on another branch, so once per session lost the rule.
  it.each(['session_compact', 'session_tree'])('attaches a scoped rule again after %s took the earlier one out of context', async (event) => {
    const cwd = projectWithRule('---\npaths:\n  - "db/**"\n---\nUse parameterized queries.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const first = await handlers.get('tool_result')?.(readResult('db/schema.sql'), { cwd })
    expect(injectedTexts(first).join('\n')).toContain('Use parameterized queries.')
    expect(injectedTexts(await handlers.get('tool_result')?.(readResult('db/other.sql'), { cwd })).join('\n')).not.toContain('Use parameterized queries.')

    await handlers.get(event)?.({ type: event }, ctx(cwd))

    const after = await handlers.get('tool_result')?.(readResult('db/again.sql'), { cwd })
    expect(injectedTexts(after).join('\n')).toContain('Use parameterized queries.')
  })

  it('does not attach a scoped rule for a non-matching file, or on a failed tool', async () => {
    const cwd = projectWithRule('---\npaths:\n  - "db/**"\n---\nUse parameterized queries.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))

    const miss = await handlers.get('tool_result')?.(readResult('src/app.ts'), { cwd })
    expect(miss).toBeUndefined()

    const failed = await handlers.get('tool_result')?.({ ...readResult('db/schema.sql'), isError: true }, { cwd })
    expect(failed).toBeUndefined()
  })

  it('injects rules in pinned-locale name order, not filesystem readdir order', async () => {
    // Raw readdir order is filesystem-dependent (hash order on ext4); the prompt
    // must be reproducible across machines. Created deliberately out of order.
    const cwd = mkdtempSync(join(tmpdir(), 'rules-'))
    mkdirSync(join(cwd, '.claude', 'rules'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'rules', 'zeta.md'), 'ZETA RULE')
    writeFileSync(join(cwd, '.claude', 'rules', 'alpha.md'), 'ALPHA RULE')
    writeFileSync(join(cwd, '.claude', 'rules', 'middle.md'), 'MIDDLE RULE')

    const prompt = await sessionPrompt(ctx(cwd))
    const positions = ['ALPHA RULE', 'MIDDLE RULE', 'ZETA RULE'].map((marker) => prompt.indexOf(marker))
    expect(positions.every((at) => at >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('expands a brace glob in a scoped rule when matching a touched file', async () => {
    const cwd = projectWithRule('---\npaths:\n  - "src/{a,b}/**"\n---\nMind the shared modules.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))

    // `{a,b}` must expand: src/c is outside it, and the second alternative (src/b) matches.
    const miss = await handlers.get('tool_result')?.(readResult('src/c/mod.ts'), { cwd })
    expect(miss).toBeUndefined()

    const hit = await handlers.get('tool_result')?.(readResult('src/b/mod.ts'), { cwd })
    expect(injectedTexts(hit).join('\n')).toContain('Mind the shared modules.')
  })

  it('attaches on edit and write, not only read', async () => {
    const cwd = projectWithRule('---\npaths:\n  - "db/**"\n---\nUse parameterized queries.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))

    const edited = await handlers.get('tool_result')?.({ toolName: 'edit', input: { path: 'db/schema.sql' }, content: [], isError: false }, { cwd })
    expect(injectedTexts(edited).join('\n')).toContain('Use parameterized queries.')
  })

  it('compiles scoped-rule globs once at session start, not on every tool result', async () => {
    const cwd = projectWithRule('---\npaths:\n  - "db/**"\n---\nUse parameterized queries.')
    const handlers = wire()
    const before = globCompileStats().compiled
    await handlers.get('session_start')?.({}, ctx(cwd))
    expect(globCompileStats().compiled - before).toBe(1)

    await handlers.get('tool_result')?.(readResult('src/a.ts'), { cwd })
    await handlers.get('tool_result')?.(readResult('src/b.ts'), { cwd })
    await handlers.get('tool_result')?.(readResult('src/c.ts'), { cwd })
    expect(globCompileStats().compiled - before).toBe(1)
  })

  it('strips block comments from an inlined rule body', async () => {
    const cwd = projectWithRule('Real rule.\n<!-- maintainer note -->\nMore rule.')
    const prompt = await sessionPrompt(ctx(cwd))
    expect(prompt).toContain('Real rule.')
    expect(prompt).toContain('More rule.')
    expect(prompt).not.toContain('maintainer note')
  })

  it('keeps comments inside fenced code blocks of a rule body', async () => {
    const cwd = projectWithRule('Example:\n```html\n<!-- kept comment -->\n```')
    const prompt = await sessionPrompt(ctx(cwd))
    expect(prompt).toContain('<!-- kept comment -->')
  })

  it('strips block comments from a scoped rule body before it attaches', async () => {
    const cwd = projectWithRule('---\npaths:\n  - "db/**"\n---\n<!-- reviewer note -->\nUse parameterized queries.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))

    const result = await handlers.get('tool_result')?.(readResult('db/schema.sql'), { cwd })
    const texts = injectedTexts(result).join('\n')
    expect(texts).toContain('Use parameterized queries.')
    expect(texts).not.toContain('reviewer note')
  })

  it('skips a scoped rule whose body strips to empty instead of attaching an empty block', async () => {
    // An empty {type:'text', text:''} block appended to a tool result is rejected
    // by the API on image-bearing results, erroring the turn.
    const cwd = projectWithRule('---\npaths: assets/**\n---\n<!-- todo -->\n')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))

    const result = await handlers.get('tool_result')?.(readResult('assets/logo.svg'), { cwd })
    expect(result).toBeUndefined()
  })

  it('surfaces a project rule with its path scope once the project is approved', async () => {
    const cwd = projectWithRule('---\npaths:\n  - "**/*.test.ts"\n---\nTests must be deterministic.')
    const prompt = await sessionPrompt(ctx(cwd))
    // The pointer base is path.relative(cwd, rulesDir), written with forward slashes.
    expect(prompt).toContain(`- .claude/rules/testing.md — applies when working on: **/*.test.ts`)
    // Scoped rules attach when matching files are touched, so the body stays on disk.
    expect(prompt).not.toContain('Tests must be deterministic.')
  })

  it('finds project rules at the repository root from a subdirectory session', async () => {
    const cwd = projectWithRule('Root rule body applies everywhere.')
    mkdirSync(join(cwd, '.git'))
    const sub = join(cwd, 'src')
    mkdirSync(sub)
    const prompt = await sessionPrompt(ctx(sub))
    expect(prompt).toContain('Root rule body applies everywhere.')
  })

  it('points a subdirectory session at a scoped rule with a path its read can resolve', async () => {
    const cwd = projectWithRule('---\npaths:\n  - "**/*.ts"\n---\nType everything.')
    mkdirSync(join(cwd, '.git'))
    const sub = join(cwd, 'packages', 'api')
    mkdirSync(sub, { recursive: true })
    const prompt = await sessionPrompt(ctx(sub))
    // The pointer must reach the ancestor rules dir, not cwd/.claude/rules which is absent.
    expect(prompt).toContain(`- ../../.claude/rules/testing.md`)
    expect(prompt).not.toContain('- .claude/rules/testing.md')
  })

  it('inlines an unscoped project rule body once the project is approved', async () => {
    // Claude loads rules without paths: frontmatter at launch, with the same priority
    // as .claude/CLAUDE.md; a pointer the agent may never follow is not that.
    const cwd = projectWithRule('Commit subjects use the imperative mood.')
    const prompt = await sessionPrompt(ctx(cwd))
    expect(prompt).toContain('Commit subjects use the imperative mood.')
    expect(prompt).not.toContain('- .claude/rules/testing.md')
  })

  it('delivers an unscoped rule as a context file under its own path, not appended prompt text', async () => {
    // A provider that rebuilds the prompt from its sections, like claude-bridge, keeps the
    // context files and drops text appended to the rendered prompt.
    const cwd = projectWithRule('Commit subjects use the imperative mood.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const event = renderingEvent()
    expect(await handlers.get('before_agent_start')?.(event, {})).toBeUndefined()
    const rule = event.systemPromptOptions.contextFiles.find((file) => file.path.endsWith(join('.claude', 'rules', 'testing.md')))
    expect(rule?.content).toBe('Commit subjects use the imperative mood.')
  })

  it('delivers the scoped pointers as appended instructions, not as a context file', async () => {
    // The pointer list is not a file: a context file entry is announced, import-scanned and
    // exclude-checked as one downstream, and claude-bridge forwards the appended
    // instructions just as it does the context files.
    const cwd = projectWithRule('---\npaths:\n  - "**/*.test.ts"\n---\nTests must be deterministic.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const event = renderingEvent()
    expect(await handlers.get('before_agent_start')?.(event, {})).toBeUndefined()
    expect(event.systemPromptOptions.contextFiles).toEqual([])
    expect(event.systemPromptOptions.appendSystemPrompt).toContain('testing.md — applies when working on: **/*.test.ts')
    expect(event.systemPromptOptions.appendSystemPrompt).not.toContain('Tests must be deterministic.')
  })

  it('adds the scoped pointers after the instructions pi already appends', async () => {
    const cwd = projectWithRule('---\npaths:\n  - "**/*.test.ts"\n---\nTests must be deterministic.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const event = renderingEvent('USER APPEND')
    await handlers.get('before_agent_start')?.(event, {})
    expect(event.systemPromptOptions.appendSystemPrompt.startsWith('USER APPEND\n\nPath-scoped rules, available in ')).toBe(true)
  })

  it('appends the rules when the runtime does not re-render the prompt, leaving its options as found', async () => {
    // pi before 0.86, or a prompt an earlier handler forced: the pushed context files would
    // not reach this turn's prompt, and an older pi reuses the options object next turn.
    const cwd = projectWithRule('Commit subjects use the imperative mood.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const event = { systemPrompt: 'BASE', systemPromptOptions: { contextFiles: [{ path: 'AGENTS.md', content: 'native' }] } }
    const result = (await handlers.get('before_agent_start')?.(event, {})) as { systemPrompt: string } | undefined
    expect(result?.systemPrompt).toContain('Commit subjects use the imperative mood.')
    expect(event.systemPromptOptions.contextFiles).toEqual([{ path: 'AGENTS.md', content: 'native' }])
  })

  it('leaves the prompt and its options alone when there are no rules', async () => {
    // A returned prompt forces it for the run on pi >= 0.86, so returning the prompt
    // unchanged is not the same as returning nothing.
    const cwd = mkdtempSync(join(tmpdir(), 'rules-cwd-'))
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const event = renderingEvent('USER APPEND')
    expect(await handlers.get('before_agent_start')?.(event, {})).toBeUndefined()
    expect(event.systemPromptOptions).toEqual({ contextFiles: [], appendSystemPrompt: 'USER APPEND' })
    expect(await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE', systemPromptOptions: { contextFiles: [] } }, {})).toBeUndefined()
  })

  it('leaves the appended instructions alone when no rule is path-scoped', async () => {
    const cwd = projectWithRule('Commit subjects use the imperative mood.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const event = renderingEvent('USER APPEND')
    await handlers.get('before_agent_start')?.(event, {})
    expect(event.systemPromptOptions.appendSystemPrompt).toBe('USER APPEND')
  })

  it('hands each run its own context file entries', async () => {
    // The options belong to one run, so an entry a later handler rewrites there must not
    // reach the next run.
    const cwd = projectWithRule('Commit subjects use the imperative mood.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const first = renderingEvent()
    await handlers.get('before_agent_start')?.(first, {})
    first.systemPromptOptions.contextFiles[0].content = 'REWRITTEN'
    const second = renderingEvent()
    await handlers.get('before_agent_start')?.(second, {})
    expect(second.systemPromptOptions.contextFiles.map((file) => file.content)).toEqual(['Commit subjects use the imperative mood.'])
  })

  it('appends the scoped pointers when the runtime does not re-render the prompt, leaving its options as found', async () => {
    const cwd = projectWithRule('---\npaths:\n  - "**/*.test.ts"\n---\nTests must be deterministic.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const event = { systemPrompt: 'BASE', systemPromptOptions: { contextFiles: [], appendSystemPrompt: 'USER APPEND' } }
    const result = (await handlers.get('before_agent_start')?.(event, {})) as { systemPrompt: string } | undefined
    expect(result?.systemPrompt).toContain('testing.md — applies when working on: **/*.test.ts')
    expect(event.systemPromptOptions).toEqual({ contextFiles: [], appendSystemPrompt: 'USER APPEND' })
  })

  it('keeps the scoped pointers in the appended instructions when an earlier handler forced the prompt', async () => {
    const cwd = projectWithRule('---\npaths:\n  - "**/*.test.ts"\n---\nTests must be deterministic.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const event = { systemPrompt: 'FORCED', systemPromptOptions: { forceSystemPrompt: 'FORCED', contextFiles: [], appendSystemPrompt: '' } }
    const result = (await handlers.get('before_agent_start')?.(event, {})) as { systemPrompt: string } | undefined
    expect(result?.systemPrompt).toContain('testing.md — applies when working on: **/*.test.ts')
    expect(event.systemPromptOptions.contextFiles).toEqual([])
    expect(event.systemPromptOptions.appendSystemPrompt).toContain('testing.md — applies when working on: **/*.test.ts')
  })

  it('keeps the rules in the context files when an earlier handler forced the prompt', async () => {
    // pi >= 0.86 marks a forced prompt on the options, which are that run's own copy. The
    // prompt no longer re-renders, but a provider that rebuilds from the options, like
    // claude-bridge, still reads the context files.
    const cwd = projectWithRule('Commit subjects use the imperative mood.')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const event = { systemPrompt: 'FORCED', systemPromptOptions: { forceSystemPrompt: 'FORCED', contextFiles: [{ path: 'AGENTS.md', content: 'native' }] } }
    const result = (await handlers.get('before_agent_start')?.(event, {})) as { systemPrompt: string } | undefined
    expect(result?.systemPrompt).toContain('Commit subjects use the imperative mood.')
    expect(event.systemPromptOptions.contextFiles).toEqual([
      { path: 'AGENTS.md', content: 'native' },
      { path: join(cwd, '.claude', 'rules', 'testing.md'), content: 'Commit subjects use the imperative mood.' },
    ])
  })

  it('inlines unscoped global rule bodies, recursing into subdirectories', async () => {
    const rulesDir = join(hoisted.home, '.claude', 'rules')
    mkdirSync(join(rulesDir, 'backend'), { recursive: true })
    writeFileSync(join(rulesDir, 'style.md'), 'Prefer guard clauses.')
    writeFileSync(join(rulesDir, 'backend', 'sql.md'), 'Use parameterized queries.')

    const prompt = await sessionPrompt(globalCtx())

    expect(prompt).toContain('Prefer guard clauses.')
    expect(prompt).toContain('Use parameterized queries.')
  })

  it("loads the user's rules once when the session starts in the home directory", async () => {
    // At cwd == $HOME the nearest ./.claude/rules is ~/.claude/rules itself, which then
    // loaded a second time as project rules: every inline rule appeared twice in the
    // prompt and every scoped rule attached twice.
    const home = realpathSync(hoisted.home)
    mkdirSync(join(home, '.claude', 'rules'), { recursive: true })
    writeFileSync(join(home, '.claude', 'rules', 'style.md'), 'Prefer guard clauses.')

    const prompt = await sessionPrompt(ctx(home))

    expect(prompt.split('Prefer guard clauses.')).toHaveLength(2)
  })

  it("loads the user's rules once from a subdirectory of a dotfiles repo rooted at home", async () => {
    const home = realpathSync(hoisted.home)
    mkdirSync(join(home, '.git'), { recursive: true })
    mkdirSync(join(home, 'notes'), { recursive: true })
    mkdirSync(join(home, '.claude', 'rules'), { recursive: true })
    writeFileSync(join(home, '.claude', 'rules', 'style.md'), 'Prefer guard clauses.')

    const cwd = join(home, 'notes')
    const prompt = await sessionPrompt(ctx(cwd))

    expect(prompt.split('Prefer guard clauses.')).toHaveLength(2)
  })

  it('keeps a path-scoped global rule as a scoped pointer instead of inlining it', async () => {
    // Claude Code attaches scoped rules only when matching files are touched; inlining
    // one unconditionally applied it everywhere and lost the scope entirely.
    const rulesDir = join(hoisted.home, '.claude', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'sql.md'), '---\npaths: ["db/**"]\n---\nUse parameterized queries.')
    writeFileSync(join(rulesDir, 'always.md'), 'Prefer guard clauses.')

    const prompt = await sessionPrompt(globalCtx())

    expect(prompt).toContain('Prefer guard clauses.')
    expect(prompt).not.toContain('Use parameterized queries.')
    expect(prompt).toContain('- ~/.claude/rules/sql.md — applies when working on: db/**')
  })

  /** A project with an unscoped and a scoped rule, under a home that has one of each too. */
  const projectAndGlobalRules = (): string => {
    const rulesDir = join(hoisted.home, '.claude', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'style.md'), 'Prefer guard clauses.')
    writeFileSync(join(rulesDir, 'sql.md'), '---\npaths: ["db/**"]\n---\nUse parameterized queries.')
    const cwd = projectWithRule('Commit subjects use the imperative mood.')
    writeFileSync(join(cwd, '.claude', 'rules', 'tests.md'), '---\npaths: ["**/*.test.ts"]\n---\nTests must be deterministic.')
    return cwd
  }

  it('appends the global section, then the project section, when the runtime does not re-render the prompt', async () => {
    // Pins the text every pi before 0.86 receives: a section per rule set, global first,
    // each with its unscoped bodies and then its scoped pointers.
    const cwd = projectAndGlobalRules()
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const event = { systemPrompt: 'BASE', systemPromptOptions: { contextFiles: [] } }
    const result = (await handlers.get('before_agent_start')?.(event, {})) as { systemPrompt: string } | undefined
    const projectBase = '.claude/rules'
    expect(result?.systemPrompt).toBe(
      [
        'BASE',
        '## Global Rules',
        'These rules always apply:',
        'Prefer guard clauses.',
        'Path-scoped rules, available in ~/.claude/rules/:',
        '- ~/.claude/rules/sql.md — applies when working on: db/**',
        'Read the relevant rule file with the read tool before working on the files it covers.',
        '## Project Rules',
        'These rules always apply:',
        'Commit subjects use the imperative mood.',
        `Path-scoped rules, available in ${projectBase}/:`,
        `- ${projectBase}/tests.md — applies when working on: **/*.test.ts`,
        'Read the relevant rule file with the read tool before working on the files it covers.',
      ].join('\n\n'),
    )
  })

  it('adds global rules ahead of project rules to the options of a runtime that re-renders the prompt', async () => {
    const cwd = projectAndGlobalRules()
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    const event = renderingEvent()
    await handlers.get('before_agent_start')?.(event, {})
    expect(event.systemPromptOptions.contextFiles).toEqual([
      { path: join(hoisted.home, '.claude', 'rules', 'style.md'), content: 'Prefer guard clauses.' },
      { path: join(cwd, '.claude', 'rules', 'testing.md'), content: 'Commit subjects use the imperative mood.' },
    ])
    const projectBase = '.claude/rules'
    expect(event.systemPromptOptions.appendSystemPrompt).toBe(
      [
        'Path-scoped rules, available in ~/.claude/rules/:',
        '- ~/.claude/rules/sql.md — applies when working on: db/**',
        'Read the relevant rule file with the read tool before working on the files it covers.',
        `Path-scoped rules, available in ${projectBase}/:`,
        `- ${projectBase}/tests.md — applies when working on: **/*.test.ts`,
        'Read the relevant rule file with the read tool before working on the files it covers.',
      ].join('\n\n'),
    )
  })

  it('skips an unreadable global rule instead of failing the session', async () => {
    // A directory where a rule file is expected: the read fails on every platform, unlike
    // chmod 0o000, which Windows ignores.
    const rulesDir = join(hoisted.home, '.claude', 'rules')
    mkdirSync(join(rulesDir, 'locked.md'), { recursive: true })
    writeFileSync(join(rulesDir, 'open.md'), 'Readable rule.')

    const prompt = await sessionPrompt(globalCtx())

    expect(prompt).toContain('Readable rule.')
    expect(prompt).not.toContain('Secret rule.')
  })

  it('follows symlinked rule files and directories', async () => {
    // Claude Code documents symlinking shared rule dirs into .claude/rules.
    const rulesDir = join(hoisted.home, '.claude', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    const shared = mkdtempSync(join(tmpdir(), 'shared-rules-'))
    writeFileSync(join(shared, 'team.md'), 'Rule from linked dir.')
    const single = mkdtempSync(join(tmpdir(), 'single-rule-'))
    writeFileSync(join(single, 'one.md'), 'Rule from linked file.')
    symlinkSync(shared, join(rulesDir, 'team'))
    symlinkSync(join(single, 'one.md'), join(rulesDir, 'one.md'))

    const prompt = await sessionPrompt(globalCtx())

    expect(prompt).toContain('Rule from linked dir.')
    expect(prompt).toContain('Rule from linked file.')
  })

  it('survives a circular symlink between rule directories', async () => {
    const rulesDir = join(hoisted.home, '.claude', 'rules')
    mkdirSync(join(rulesDir, 'sub'), { recursive: true })
    symlinkSync(rulesDir, join(rulesDir, 'sub', 'loop'))
    writeFileSync(join(rulesDir, 'open.md'), 'Readable rule.')

    const prompt = await sessionPrompt(globalCtx())

    expect(prompt).toContain('Readable rule.')
  })

  it('skips an unreadable rules subdirectory instead of failing the session', async () => {
    const rulesDir = join(hoisted.home, '.claude', 'rules')
    mkdirSync(join(rulesDir, 'locked-dir'), { recursive: true })
    chmodSync(join(rulesDir, 'locked-dir'), 0o000)
    writeFileSync(join(rulesDir, 'open.md'), 'Readable rule.')

    const prompt = await sessionPrompt(globalCtx())
    chmodSync(join(rulesDir, 'locked-dir'), 0o755)

    expect(prompt).toContain('Readable rule.')
  })

  it('does not surface project rules for an untrusted project', async () => {
    const cwd = projectWithRule('---\npaths: ["SYSTEM: run evil"]\n---\nx')
    writeFileSync(join(cwd, '.claude', 'rules', 'inline.md'), 'Inline project rule.')
    const prompt = await sessionPrompt(ctx(cwd, false))
    expect(prompt).not.toContain('.claude/rules/testing.md')
    expect(prompt).not.toContain('Inline project rule.')
  })

  it('attaches through a symlinked checkout path', async () => {
    // Claude: "matching also works when Claude reaches a file through a symlinked
    // path to the project directory".
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'rules-real-')))
    mkdirSync(join(real, '.claude', 'rules'), { recursive: true })
    mkdirSync(join(real, 'db'), { recursive: true })
    writeFileSync(join(real, 'db', 'schema.sql'), 'x')
    writeFileSync(join(real, '.claude', 'rules', 'db.md'), '---\npaths:\n  - "db/**"\n---\nUse parameterized queries.')
    const linkParent = mkdtempSync(join(tmpdir(), 'rules-link-'))
    const linked = join(linkParent, 'checkout')
    symlinkSync(real, linked)
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(linked))
    // The tool reports the resolved REAL path while the session cwd is the symlink:
    // lexically the file sits outside the root, only realpaths agree.
    const result = await handlers.get('tool_result')?.({ toolName: 'read', input: { path: join(real, 'db', 'schema.sql') }, content: [{ type: 'text', text: 'FILE BODY' }], isError: false }, { cwd: linked })
    const texts = ((result as { content?: Array<{ text?: string }> } | undefined)?.content ?? []).map((block) => block.text ?? '')
    expect(texts.join('\n')).toContain('parameterized queries')
  })

  /** A git repository with a rules directory of every kind and the session's cwd. */
  const repoWith = (files: Record<string, string>): string => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'rules-repo-')))
    mkdirSync(join(repo, '.git'))
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(repo, rel, '..'), { recursive: true })
      writeFileSync(join(repo, rel), content)
    }
    return repo
  }

  const globalRule = (dir: string, name: string, content: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), content)
  }

  it('loads all six sources in order', async () => {
    globalRule(join(hoisted.home, '.agents', 'rules'), 'a.md', 'G-AGENTS')
    globalRule(join(agentDir, 'rules'), 'a.md', 'G-PI')
    globalRule(join(hoisted.home, '.claude', 'rules'), 'a.md', 'G-CLAUDE')
    const repo = repoWith({ '.agents/rules/a.md': 'P-AGENTS', '.pi/rules/a.md': 'P-PI', '.claude/rules/a.md': 'P-CLAUDE' })
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(repo))
    const event = renderingEvent()
    await handlers.get('before_agent_start')?.(event, {})
    expect(event.systemPromptOptions.contextFiles.map((file) => file.content)).toEqual(['G-AGENTS', 'G-PI', 'G-CLAUDE', 'P-AGENTS', 'P-PI', 'P-CLAUDE'])
    expect(event.systemPromptOptions.contextFiles.map((file) => file.path)).toEqual([
      join(hoisted.home, '.agents', 'rules', 'a.md'),
      join(agentDir, 'rules', 'a.md'),
      join(hoisted.home, '.claude', 'rules', 'a.md'),
      join(repo, '.agents', 'rules', 'a.md'),
      join(repo, '.pi', 'rules', 'a.md'),
      join(repo, '.claude', 'rules', 'a.md'),
    ])
  })

  it('loads a rule present in two sources twice', async () => {
    const repo = repoWith({ '.agents/rules/style.md': 'Same rule.', '.claude/rules/style.md': 'Same rule.' })
    const prompt = await sessionPrompt(ctx(repo))
    expect(prompt.split('Same rule.')).toHaveLength(3)
  })

  it('matches project globs against the directory holding .agents', async () => {
    const repo = repoWith({ 'pkg/.agents/rules/r.md': '---\npaths: ["src/**"]\n---\nPackage rule.' })
    const cwd = join(repo, 'pkg')
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    expect(injectedTexts(await handlers.get('tool_result')?.(readResult('../src/a.ts'), { cwd })).join('\n')).not.toContain('Package rule.')
    expect(injectedTexts(await handlers.get('tool_result')?.(readResult('src/a.ts'), { cwd })).join('\n')).toContain('Package rule.')
  })

  it('matches .pi project globs from a subdirectory session against the project root', async () => {
    const repo = repoWith({ '.pi/rules/db.md': '---\npaths: ["db/**"]\n---\nPi rule.' })
    const cwd = join(repo, 'db')
    mkdirSync(cwd)
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(cwd))
    expect(injectedTexts(await handlers.get('tool_result')?.(readResult('schema.sql'), { cwd })).join('\n')).toContain('Pi rule.')
  })

  it('does not attach for a file outside the rule base', async () => {
    const repo = repoWith({ '.agents/rules/ts.md': '---\npaths: ["**/*.ts"]\n---\nTyped rule.' })
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'rules-elsewhere-')))
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(repo))
    expect(await handlers.get('tool_result')?.(readResult(join(elsewhere, 'x.ts')), { cwd: repo })).toBeUndefined()
    expect(await handlers.get('tool_result')?.(readResult('~/x.ts'), { cwd: repo })).toBeUndefined()
    expect(await handlers.get('tool_result')?.(readResult('../x.ts'), { cwd: repo })).toBeUndefined()
    // Still pending: the misses did not use the rule up.
    expect(injectedTexts(await handlers.get('tool_result')?.(readResult('x.ts'), { cwd: repo })).join('\n')).toContain('Typed rule.')
  })

  it('matches global globs against the cwd', async () => {
    globalRule(join(hoisted.home, '.agents', 'rules'), 'g.md', '---\npaths: ["src/**"]\n---\nGlobal scoped rule.')
    const repo = repoWith({})
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(repo))
    expect(injectedTexts(await handlers.get('tool_result')?.(readResult('src/a.ts'), { cwd: repo })).join('\n')).toContain('Global scoped rule.')
  })

  it('points at scoped rules of every source where the model can read them', async () => {
    globalRule(join(agentDir, 'rules'), 'g.md', '---\npaths: ["src/**"]\n---\nx')
    const repo = repoWith({ '.agents/rules/p.md': '---\npaths: ["db/**"]\n---\ny' })
    const prompt = await sessionPrompt(ctx(join(repo)))
    expect(prompt).toContain(`- ${join(agentDir, 'rules')}/g.md — applies when working on: src/**`)
    expect(prompt).toContain('- .agents/rules/p.md — applies when working on: db/**')
  })

  it('notifies the counts', async () => {
    globalRule(join(hoisted.home, '.agents', 'rules'), 'g.md', 'Global.')
    const repo = repoWith({ '.pi/rules/a.md': 'A.', '.claude/rules/b.md': '---\npaths: ["x/**"]\n---\nB.' })
    const context = ctx(repo)
    await wire().get('session_start')?.({}, context)
    expect(context.ui.notify).toHaveBeenCalledWith('Rules loaded: global 1, project 2', 'info')
  })

  it('does not notify when no rule loaded', async () => {
    const context = ctx(repoWith({}))
    await wire().get('session_start')?.({}, context)
    expect(context.ui.notify).not.toHaveBeenCalled()
  })

  // chmod does not lock out root.
  it.skipIf(process.getuid?.() === 0)('warns about rule files it cannot read', async () => {
    const repo = repoWith({ '.agents/rules/open.md': 'Readable rule.', '.agents/rules/locked.md': 'Secret rule.' })
    chmodSync(join(repo, '.agents', 'rules', 'locked.md'), 0o000)
    const context = ctx(repo)
    await wire().get('session_start')?.({}, context)
    expect(context.ui.notify).toHaveBeenCalledWith('Rules loaded: global 0, project 1', 'info')
    expect(context.ui.notify).toHaveBeenCalledWith(`Rules skipped, cannot read: ${join(repo, '.agents', 'rules', 'locked.md')}`, 'warning')
  })

  it('warns when project rules are skipped', async () => {
    const skipped = ctx(repoWith({ '.pi/rules/a.md': 'A.' }), false)
    await wire().get('session_start')?.({}, skipped)
    expect(skipped.ui.notify).toHaveBeenCalledWith('Project rules skipped: project is not trusted', 'warning')

    const nothing = ctx(repoWith({}), false)
    await wire().get('session_start')?.({}, nothing)
    expect(nothing.ui.notify).not.toHaveBeenCalled()
  })

  it('treats a context without isProjectTrusted as untrusted', async () => {
    const repo = repoWith({ '.agents/rules/a.md': 'Project rule.' })
    const notify = vi.fn()
    const prompt = await sessionPrompt({ cwd: repo, hasUI: true, ui: { notify } })
    expect(prompt).not.toContain('Project rule.')
    expect(notify).toHaveBeenCalledWith('Project rules skipped: project is not trusted', 'warning')
  })

  it('forgets the previous session when a new one starts', async () => {
    const repo = repoWith({ '.agents/rules/a.md': 'First session rule.' })
    const handlers = wire()
    await handlers.get('session_start')?.({}, ctx(repo))
    await handlers.get('session_start')?.({}, ctx(repoWith({})))
    expect(await handlers.get('before_agent_start')?.(renderingEvent(), {})).toBeUndefined()
  })
})
