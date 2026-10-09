import { describe, expect, it } from 'vitest'

import { applyRules, type ContextFile, NO_PROMPT_RULES, type PromptOptions, promptRules } from '../extensions/internal/prompt.ts'
import type { RuleSet } from '../extensions/internal/rule-files.ts'
import type { LoadedSource, RuleSource } from '../extensions/internal/sources.ts'

const source = (scope: RuleSource['scope'], pointerBase: string): RuleSource => ({ scope, dir: `/abs/${pointerBase}`, globBase: '/abs', pointerBase })

const unscopedOnly = (...files: string[]): RuleSet => ({ unscoped: files.map((file) => ({ file, body: `body of ${file}` })), scoped: [], unreadable: [] })

const scopedOnly = (rel: string, paths: string[], body = 'Scoped body.'): RuleSet => ({ unscoped: [], scoped: [{ rel, file: `/abs/${rel}`, paths, body }], unreadable: [] })

const POINTER_FOOTER = 'Read the relevant rule file with the read tool before working on the files it covers.'

describe('promptRules', () => {
  it('lists unscoped rules as context files in source order', () => {
    const loaded: LoadedSource[] = [
      { source: source('global', '~/.agents/rules'), rules: unscopedOnly('/g/agents/a.md') },
      { source: source('global', '~/.claude/rules'), rules: unscopedOnly('/g/claude/a.md') },
      { source: source('project', '.agents/rules'), rules: unscopedOnly('/p/.agents/rules/style.md') },
      { source: source('project', '.claude/rules'), rules: unscopedOnly('/p/.claude/rules/style.md') },
    ]
    const rules = promptRules(loaded)
    expect(rules.contextFiles).toEqual([
      { path: '/g/agents/a.md', content: 'body of /g/agents/a.md' },
      { path: '/g/claude/a.md', content: 'body of /g/claude/a.md' },
      { path: '/p/.agents/rules/style.md', content: 'body of /p/.agents/rules/style.md' },
      { path: '/p/.claude/rules/style.md', content: 'body of /p/.claude/rules/style.md' },
    ])
    expect(rules.pointers).toBe('')
  })

  it('writes one pointer block per source with scoped rules', () => {
    const single = promptRules([{ source: source('global', '~/.agents/rules'), rules: scopedOnly('api.md', ['src/**', '**/*.api.ts']) }])
    expect(single.pointers).toBe(`Path-scoped rules, available in ~/.agents/rules/:\n\n- ~/.agents/rules/api.md — applies when working on: src/**, **/*.api.ts\n\n${POINTER_FOOTER}`)
    expect(single.contextFiles).toEqual([])

    const two = promptRules([
      { source: source('global', '~/.agents/rules'), rules: scopedOnly('api.md', ['src/**']) },
      { source: source('project', '.pi/rules'), rules: unscopedOnly('/p/.pi/rules/a.md') },
      { source: source('project', '.claude/rules'), rules: scopedOnly('db.md', ['db/**']) },
    ])
    expect(two.pointers.split('\n\n').filter((block) => block.startsWith('Path-scoped rules'))).toEqual(['Path-scoped rules, available in ~/.agents/rules/:', 'Path-scoped rules, available in .claude/rules/:'])
  })

  it('builds global then project sections', () => {
    const rules = promptRules([
      { source: source('global', '~/.agents/rules'), rules: unscopedOnly('/g/one.md') },
      { source: source('global', '~/.claude/rules'), rules: scopedOnly('sql.md', ['db/**']) },
      { source: source('project', '.agents/rules'), rules: unscopedOnly('/p/two.md') },
    ])
    expect(rules.fallbackText).toBe(
      ['\n\n## Global Rules', 'These rules always apply:', 'body of /g/one.md', 'Path-scoped rules, available in ~/.claude/rules/:', '- ~/.claude/rules/sql.md — applies when working on: db/**', POINTER_FOOTER, '## Project Rules', 'These rules always apply:', 'body of /p/two.md'].join('\n\n'),
    )
  })

  it('joins the unscoped bodies of all sources of a scope under one heading', () => {
    const rules = promptRules([
      { source: source('project', '.agents/rules'), rules: unscopedOnly('/p/a.md') },
      { source: source('project', '.claude/rules'), rules: unscopedOnly('/p/b.md') },
    ])
    expect(rules.fallbackText).toBe('\n\n## Project Rules\n\nThese rules always apply:\n\nbody of /p/a.md\n\nbody of /p/b.md')
  })

  it('returns empty strings and no files without rules', () => {
    expect(promptRules([])).toEqual(NO_PROMPT_RULES)
    expect(promptRules([{ source: source('global', '~/.agents/rules'), rules: { unscoped: [], scoped: [], unreadable: [] } }])).toEqual(NO_PROMPT_RULES)
  })
})

describe('applyRules', () => {
  const foreign: ContextFile = { path: '/repo/AGENTS.md', content: 'Agents.' }
  const rules = promptRules([{ source: source('project', '.agents/rules'), rules: { unscoped: [{ file: '/p/a.md', body: 'A.' }], scoped: [{ rel: 'b.md', file: '/p/b.md', paths: ['src/**'], body: 'B.' }], unreadable: [] } }])

  /** An event like pi >= 0.86's: systemPrompt re-renders from the mutable options. */
  const renderingEvent = (options: PromptOptions) => ({
    systemPromptOptions: options,
    get systemPrompt(): string {
      return ['BASE', options.appendSystemPrompt ?? '', ...(options.contextFiles ?? []).map((file) => file.content)].join('|')
    },
  })

  it('edits the options of a prompt that re-renders, after what is already there', () => {
    const options: PromptOptions = { contextFiles: [{ ...foreign }], appendSystemPrompt: 'X' }
    expect(applyRules(renderingEvent(options), rules)).toBeUndefined()
    expect(options.appendSystemPrompt).toBe(`X\n\n${rules.pointers}`)
    expect(options.contextFiles).toEqual([foreign, { path: '/p/a.md', content: 'A.' }])
    // Copies: the options of one run must not share entries with the next.
    expect(options.contextFiles?.[1]).not.toBe(rules.contextFiles[0])
  })

  it('appends the fallback text to a prompt that does not re-render, leaving its options as found', () => {
    const options: PromptOptions = { contextFiles: [{ ...foreign }], appendSystemPrompt: 'X' }
    expect(applyRules({ systemPrompt: 'BASE', systemPromptOptions: options }, rules)).toEqual({ systemPrompt: `BASE${rules.fallbackText}` })
    expect(options).toEqual({ contextFiles: [foreign], appendSystemPrompt: 'X' })
    expect(applyRules({ systemPrompt: 'BASE' }, rules)).toEqual({ systemPrompt: `BASE${rules.fallbackText}` })
  })

  it('keeps the rules in the options of a prompt an earlier handler forced', () => {
    const options: PromptOptions = { contextFiles: [], forceSystemPrompt: 'FORCED' }
    expect(applyRules({ systemPrompt: 'FORCED', systemPromptOptions: options }, rules)).toEqual({ systemPrompt: `FORCED${rules.fallbackText}` })
    expect(options.contextFiles).toEqual([{ path: '/p/a.md', content: 'A.' }])
    expect(options.appendSystemPrompt).toBe(rules.pointers)
  })

  it('leaves the prompt and its options alone without rules', () => {
    const options: PromptOptions = { contextFiles: [], appendSystemPrompt: 'X' }
    expect(applyRules(renderingEvent(options), NO_PROMPT_RULES)).toBeUndefined()
    expect(options).toEqual({ contextFiles: [], appendSystemPrompt: 'X' })
  })
})
