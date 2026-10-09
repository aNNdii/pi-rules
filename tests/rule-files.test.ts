import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseFrontmatter, readRules } from '../extensions/internal/rule-files.ts'

// parseFrontmatter cases ported from
// ilovepixelart/pi-code@2efd7c6921f80ef7d31e8adf3cce828fac082998, tests/claude-rules.test.ts.
describe('parseFrontmatter', () => {
  it('returns the whole content as body when there is no frontmatter', () => {
    expect(parseFrontmatter('Just rules.')).toEqual({ paths: [], body: 'Just rules.' })
  })

  it('detects frontmatter behind a UTF-8 byte order mark', () => {
    // Windows editors prepend one; without this the whole header leaked into the body
    // and the rule lost its path scope.
    expect(parseFrontmatter('\uFEFF---\npaths: ["src/**"]\n---\nBody')).toEqual({ paths: ['src/**'], body: 'Body' })
  })

  it('parses a block list of paths and strips the frontmatter from the body', () => {
    const md = '---\npaths:\n  - "src/**/*.ts"\n  - "**/*.test.ts"\n---\nUse strict types.'
    expect(parseFrontmatter(md)).toEqual({ paths: ['src/**/*.ts', '**/*.test.ts'], body: 'Use strict types.' })
  })

  it('ends the block list at a dash entry with no value', () => {
    const md = '---\npaths:\n  - a.ts\n  -   \n  - b.ts\n---\nbody'
    expect(parseFrontmatter(md).paths).toEqual(['a.ts'])
  })

  it('parses an inline array of paths', () => {
    expect(parseFrontmatter('---\npaths: ["a.ts", "b.ts"]\n---\nbody').paths).toEqual(['a.ts', 'b.ts'])
  })

  it('keeps a brace group whole when splitting an inline list', () => {
    // Claude's rules support brace expansion in paths, so the comma inside {ts,tsx} is
    // part of one pattern. Splitting on it produced two patterns that match nothing and
    // the rule silently stopped attaching to anything.
    expect(parseFrontmatter('---\npaths: ["src/**/*.{ts,tsx}", "lib/**"]\n---\nbody').paths).toEqual(['src/**/*.{ts,tsx}', 'lib/**'])
    // Unquoted too: YAML does not require quotes, and the braces are what delimits the group.
    expect(parseFrontmatter('---\npaths: [src/**/*.{ts,tsx}, lib/**]\n---\nbody').paths).toEqual(['src/**/*.{ts,tsx}', 'lib/**'])
  })

  it('parses an inline list spread over several lines', () => {
    // A list written across lines read as an empty paths value, which makes a scoped rule
    // unscoped: it was injected into every session instead of the files it names.
    const md = '---\npaths: [\n  "src/**",\n  "docs/**"\n]\n---\nbody'
    expect(parseFrontmatter(md).paths).toEqual(['src/**', 'docs/**'])
  })

  it('parses a comma-separated inline paths value', () => {
    expect(parseFrontmatter('---\npaths: a.ts, b.ts\n---\nbody').paths).toEqual(['a.ts', 'b.ts'])
  })

  it('returns no paths when the frontmatter lacks a paths key', () => {
    expect(parseFrontmatter('---\ndescription: hi\n---\nbody')).toEqual({ paths: [], body: 'body' })
  })
})

describe('parseFrontmatter CRLF', () => {
  it('parses CRLF frontmatter authored on Windows', () => {
    expect(parseFrontmatter('---\r\npaths:\r\n  - "**/*.ts"\r\n---\r\nbody').paths).toEqual(['**/*.ts'])
  })
})

describe('readRules', () => {
  const rulesDir = (): string => mkdtempSync(join(tmpdir(), 'rule-files-'))
  const isRoot = process.getuid?.() === 0
  const NO_RULES = { unscoped: [], scoped: [], unreadable: [] }

  it('splits rules without paths into unscoped and with paths into scoped', () => {
    const dir = rulesDir()
    writeFileSync(join(dir, 'a.md'), 'Always.')
    writeFileSync(join(dir, 'b.md'), '---\npaths: ["src/**"]\n---\nScoped.')
    const rules = readRules(dir)
    expect(rules.unscoped).toEqual([{ file: join(dir, 'a.md'), body: 'Always.' }])
    expect(rules.scoped).toEqual([{ rel: 'b.md', file: join(dir, 'b.md'), paths: ['src/**'], body: 'Scoped.' }])
  })

  it('recurses into subdirectories and reports rel with forward slashes', () => {
    const dir = rulesDir()
    mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'deeper', 'c.md'), '---\npaths: db/**\n---\nDeep.')
    expect(readRules(dir).scoped.map((rule) => rule.rel)).toEqual(['sub/deeper/c.md'])
  })

  it('orders files by name with a pinned locale', () => {
    const dir = rulesDir()
    for (const name of ['b.md', 'B2.md', 'a.md']) writeFileSync(join(dir, name), name)
    const expected = ['b.md', 'B2.md', 'a.md'].sort((x, y) => x.localeCompare(y, 'en'))
    expect(readRules(dir).unscoped.map((rule) => rule.body)).toEqual(expected)
  })

  it('strips block comments and trims the body', () => {
    const dir = rulesDir()
    writeFileSync(join(dir, 'a.md'), '\n<!-- maintainer note -->\nKeep this.\n\n')
    expect(readRules(dir).unscoped[0].body).toBe('Keep this.')
  })

  it('keeps comments inside fenced code blocks', () => {
    const dir = rulesDir()
    writeFileSync(join(dir, 'a.md'), 'Example:\n```html\n<!-- kept -->\n```')
    expect(readRules(dir).unscoped[0].body).toContain('<!-- kept -->')
  })

  it('skips a rule whose body strips to empty', () => {
    const dir = rulesDir()
    writeFileSync(join(dir, 'empty.md'), '---\npaths: ["src/**"]\n---\n<!-- nothing -->\n')
    writeFileSync(join(dir, 'blank.md'), '   \n')
    expect(readRules(dir)).toEqual(NO_RULES)
  })

  it('ignores files that are not .md', () => {
    const dir = rulesDir()
    writeFileSync(join(dir, 'notes.txt'), 'Not a rule.')
    writeFileSync(join(dir, 'rule.md'), 'A rule.')
    expect(readRules(dir).unscoped.map((rule) => rule.body)).toEqual(['A rule.'])
  })

  it('follows symlinked files and directories', () => {
    const dir = rulesDir()
    const shared = mkdtempSync(join(tmpdir(), 'shared-rules-'))
    writeFileSync(join(shared, 'team.md'), 'Rule from linked dir.')
    const single = mkdtempSync(join(tmpdir(), 'single-rule-'))
    writeFileSync(join(single, 'one.md'), 'Rule from linked file.')
    symlinkSync(shared, join(dir, 'team'))
    symlinkSync(join(single, 'one.md'), join(dir, 'one.md'))
    const bodies = readRules(dir).unscoped.map((rule) => rule.body)
    expect(bodies).toContain('Rule from linked dir.')
    expect(bodies).toContain('Rule from linked file.')
  })

  it('survives a circular symlink and skips a dangling one', () => {
    const dir = rulesDir()
    mkdirSync(join(dir, 'sub'))
    symlinkSync(dir, join(dir, 'sub', 'loop'))
    symlinkSync(join(dir, 'missing.md'), join(dir, 'dangling.md'))
    writeFileSync(join(dir, 'open.md'), 'Readable rule.')
    const rules = readRules(dir)
    expect(rules.unscoped.map((rule) => rule.body)).toEqual(['Readable rule.'])
    // A dangling link names nothing to read; it is not reported as unreadable.
    expect(rules.unreadable).toEqual([])
  })

  it('treats a directory named like a rule as a directory', () => {
    const dir = rulesDir()
    mkdirSync(join(dir, 'group.md'))
    writeFileSync(join(dir, 'group.md', 'inner.md'), 'Inner rule.')
    expect(readRules(dir)).toEqual({ unscoped: [{ file: join(dir, 'group.md', 'inner.md'), body: 'Inner rule.' }], scoped: [], unreadable: [] })
  })

  it.skipIf(isRoot)('skips and reports an unreadable file and an unreadable subdirectory', () => {
    const dir = rulesDir()
    writeFileSync(join(dir, 'locked.md'), 'Secret rule.')
    chmodSync(join(dir, 'locked.md'), 0o000)
    mkdirSync(join(dir, 'locked-dir'))
    writeFileSync(join(dir, 'locked-dir', 'inner.md'), 'Inner rule.')
    chmodSync(join(dir, 'locked-dir'), 0o000)
    writeFileSync(join(dir, 'open.md'), 'Readable rule.')
    try {
      const rules = readRules(dir)
      expect(rules.unscoped.map((rule) => rule.body)).toEqual(['Readable rule.'])
      expect(new Set(rules.unreadable)).toEqual(new Set([join(dir, 'locked-dir'), join(dir, 'locked.md')]))
    } finally {
      chmodSync(join(dir, 'locked-dir'), 0o755)
    }
  })

  it('returns no rules for a missing directory', () => {
    expect(readRules(join(rulesDir(), 'absent'))).toEqual(NO_RULES)
  })
})
