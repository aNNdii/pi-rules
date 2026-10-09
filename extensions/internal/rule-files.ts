// Adapted from ilovepixelart/pi-code@2efd7c6921f80ef7d31e8adf3cce828fac082998, extensions/claude-rules.ts (MIT, see LICENSES/pi-code.txt).
// Changes: readRules reports unreadable paths and has no claudeMdExcludes filter; pointer text moved to prompt.ts.

/**
 * Rule files: frontmatter parsing, Markdown discovery under a rules directory, and the
 * split into unscoped (always-applying) and path-scoped rules.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { stripBlockComments } from './strip-comments.js'

export interface Frontmatter {
  paths: string[]
  body: string
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

/** Split a YAML flow sequence on its top-level commas. A comma inside a brace group
 * (`*.{ts,tsx}`, which the glob matcher expands) or inside quotes belongs to its entry, so
 * splitting on every comma produced patterns that match nothing. */
function splitInline(value: string): string[] {
  const entries: string[] = []
  let current = ''
  let depth = 0
  let quote: string | undefined
  for (const char of value.replace(/^\[/, '').replace(/\]$/, '')) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '{') depth++
    else if (char === '}') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) {
      entries.push(current)
      current = ''
      continue
    }
    current += char
  }
  entries.push(current)
  return entries.map((entry) => unquote(entry.trim())).filter(Boolean)
}

/** A flow sequence that opens on the `paths:` line and closes on a later one, joined
 * back into a single value. An unterminated list runs to the end of the frontmatter. */
function joinFlowSequence(lines: string[], index: number, opening: string): string {
  let joined = opening
  for (let i = index + 1; i < lines.length; i++) {
    joined += ` ${lines[i].trim()}`
    if (lines[i].includes(']')) break
  }
  return joined
}

function parsePaths(frontmatter: string): string[] {
  const lines = frontmatter.split('\n')
  const index = lines.findIndex((line) => /^\s*paths\s*:/.test(line))
  if (index === -1) return []
  const inline = lines[index].replace(/^\s*paths\s*:/, '').trim()
  if (inline) return splitInline(inline.startsWith('[') && !inline.includes(']') ? joinFlowSequence(lines, index, inline) : inline)
  const items: string[] = []
  // Matched with string ops rather than a regex: the equivalent pattern needs two
  // adjacent whitespace quantifiers, which backtracks super-linearly on long lines.
  for (let i = index + 1; i < lines.length; i++) {
    const entry = lines[i].trimStart()
    if (!entry.startsWith('-')) break
    const value = entry.slice(1).trim()
    if (!value) break
    items.push(unquote(value))
  }
  return items
}

/** Split YAML-ish frontmatter off the front of a rule file, extracting `paths`. */
export function parseFrontmatter(content: string): Frontmatter {
  // A leading byte order mark (Windows editors add one) is part of the header, not the body.
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) return { paths: [], body: content }
  return { paths: parsePaths(match[1]), body: content.slice(match[0].length) }
}

/** A dirent's kind with symlinks resolved; nulls a dangling link. */
function classifyEntry(entry: fs.Dirent, fullPath: string): { isDir: boolean; isFile: boolean } | null {
  if (!entry.isSymbolicLink()) return { isDir: entry.isDirectory(), isFile: entry.isFile() }
  try {
    const stat = fs.statSync(fullPath)
    return { isDir: stat.isDirectory(), isFile: stat.isFile() }
  } catch {
    return null
  }
}

/** Recursively find all .md files below `dir`, as paths relative to it with `/`, following
 * symlinks (shared rule directories are commonly linked in); `visited` realpaths keep a
 * circular link from recursing forever. A directory that exists but cannot be listed is
 * added to `unreadable` (absolute), so one locked directory does not take down session start. */
function findMarkdownFiles(dir: string, unreadable: string[], basePath = '', visited = new Set<string>()): string[] {
  const results: string[] = []
  try {
    const real = fs.realpathSync(dir)
    if (visited.has(real)) return results
    visited.add(real)
  } catch {
    return results // missing: an empty source, not an error
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    unreadable.push(dir)
    return results
  }
  // Raw readdir order is filesystem-dependent (hash order on ext4, sorted on
  // APFS), so unsorted iteration injects rules into the prompt in a different
  // order per machine. Pinned-locale sort makes the prompt reproducible.
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  for (const entry of entries) {
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name
    const fullPath = path.join(dir, entry.name)
    const kind = classifyEntry(entry, fullPath)
    if (!kind) continue
    if (kind.isDir) {
      results.push(...findMarkdownFiles(fullPath, unreadable, relativePath, visited))
    } else if (kind.isFile && entry.name.endsWith('.md')) {
      results.push(relativePath)
    }
  }
  return results
}

/** A rule without `paths:`. It always applies. */
export interface UnscopedRule {
  /** The rule file's absolute path. */
  file: string
  body: string
}

/** A rule with `paths:`. It applies to the files its globs cover. */
export interface ScopedRule {
  /** The rule file's path relative to its rules directory, with `/`. */
  rel: string
  /** The rule file's absolute path. */
  file: string
  /** The `paths:` globs as written. */
  paths: string[]
  /** The rule text, attached when a matching file is touched. */
  body: string
}

export interface RuleSet {
  unscoped: UnscopedRule[]
  scoped: ScopedRule[]
  /** Absolute paths of rule files and directories that exist but could not be read. */
  unreadable: string[]
}

/**
 * Every `.md` rule below `rulesDir`, in name order per directory. Frontmatter is split off,
 * block comments outside code fences are removed (they are notes for maintainers, not for
 * the model) and the body is trimmed; a rule whose body is then empty is skipped, since an
 * empty text block attached to a tool result is rejected by the API. A missing `rulesDir`
 * yields no rules; files and directories that cannot be read are skipped and listed in
 * `unreadable`. Never throws.
 */
export function readRules(rulesDir: string): RuleSet {
  const unscoped: UnscopedRule[] = []
  const scoped: ScopedRule[] = []
  const unreadable: string[] = []
  for (const rel of findMarkdownFiles(rulesDir, unreadable)) {
    const file = path.join(rulesDir, rel)
    let parsed: Frontmatter
    try {
      parsed = parseFrontmatter(fs.readFileSync(file, 'utf-8'))
    } catch {
      unreadable.push(file)
      continue
    }
    const body = stripBlockComments(parsed.body).trim()
    if (body.length === 0) continue
    if (parsed.paths.length > 0) scoped.push({ rel, file, paths: parsed.paths, body })
    else unscoped.push({ file, body })
  }
  return { unscoped, scoped, unreadable }
}
