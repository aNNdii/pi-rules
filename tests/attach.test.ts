import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PendingRules } from '../extensions/internal/attach.ts'
import { globCompileStats } from '../extensions/internal/path-rules.ts'
import type { LoadedSource } from '../extensions/internal/sources.ts'

/** One source whose scoped rules match relative to `globBase`. */
const loaded = (globBase: string, rules: Array<{ paths: string[]; body: string }>): LoadedSource[] => [
  {
    source: { scope: 'project', dir: join(globBase, '.agents', 'rules'), globBase, pointerBase: '.agents/rules' },
    rules: { unscoped: [], scoped: rules.map((rule, index) => ({ rel: `r${index}.md`, file: join(globBase, `r${index}.md`), ...rule })), unreadable: [] },
  },
]

const base = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'rules-attach-')))

describe('PendingRules', () => {
  it('hands out a matching rule once, until rearm puts it back', () => {
    const root = base()
    const pending = new PendingRules(loaded(root, [{ paths: ['db/**'], body: 'DB rule.' }]))
    expect(pending.count).toBe(1)
    expect(pending.take(join(root, 'src', 'a.ts'))).toEqual([])
    expect(pending.take(join(root, 'db', 'a.sql'))).toEqual(['DB rule.'])
    expect(pending.take(join(root, 'db', 'b.sql'))).toEqual([])
    expect(pending.count).toBe(0)
    pending.rearm()
    expect(pending.count).toBe(1)
    expect(pending.take(join(root, 'db', 'c.sql'))).toEqual(['DB rule.'])
  })

  it('hands out every rule a file matches, in load order', () => {
    const root = base()
    const pending = new PendingRules(
      loaded(root, [
        { paths: ['**/*.ts'], body: 'First.' },
        { paths: ['src/**'], body: 'Second.' },
      ]),
    )
    expect(pending.take(join(root, 'src', 'a.ts'))).toEqual(['First.', 'Second.'])
  })

  it('does not hand out a rule for a file outside its glob base', () => {
    const root = base()
    const pending = new PendingRules(loaded(join(root, 'repo'), [{ paths: ['**/*.ts'], body: 'Typed.' }]))
    expect(pending.take(join(root, 'x.ts'))).toEqual([])
    expect(pending.take(join(root, 'other', 'x.ts'))).toEqual([])
    // A name that starts with two dots is inside, not a parent traversal.
    expect(pending.take(join(root, 'repo', '..x.ts'))).toEqual(['Typed.'])
  })

  it('resolves a file reached through a symlink against the real glob base', () => {
    const root = base()
    mkdirSync(join(root, 'real', 'db'), { recursive: true })
    symlinkSync(join(root, 'real'), join(root, 'link'))
    const pending = new PendingRules(loaded(join(root, 'real'), [{ paths: ['db/**'], body: 'DB rule.' }]))
    expect(pending.take(join(root, 'link', 'db', 'a.sql'))).toEqual(['DB rule.'])
  })

  // Ported from ilovepixelart/pi-code@2efd7c6921f80ef7d31e8adf3cce828fac082998, tests/claude-rules.test.ts.
  it('compiles globs once and drops an attached rule from the working list', () => {
    const root = base()
    const before = globCompileStats().compiled
    const pending = new PendingRules(
      loaded(root, [
        { paths: ['db/**'], body: 'DB rule.' },
        { paths: ['docs/**'], body: 'Docs rule.' },
      ]),
    )
    expect(globCompileStats().compiled - before).toBe(2)

    pending.take(join(root, 'db', 'schema.sql'))
    expect(pending.count).toBe(1)

    // Only the docs rule is still pending, so this touch evaluates one rule, not two.
    const evaluated = globCompileStats().evaluated
    pending.take(join(root, 'db', 'other.sql'))
    expect(globCompileStats().evaluated - evaluated).toBe(1)

    pending.take(join(root, 'docs', 'readme.md'))
    expect(pending.count).toBe(0)

    // With every rule attached, a later touch compiles and evaluates nothing.
    const done = globCompileStats()
    pending.take(join(root, 'db', 'third.sql'))
    expect(globCompileStats()).toEqual(done)
  })

  it('has nothing pending without sources', () => {
    const pending = new PendingRules([])
    expect(pending.count).toBe(0)
    expect(pending.take('/anything')).toEqual([])
  })
})
