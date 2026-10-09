// The upward walk (repoRoot, findNearestDir) is adapted from ilovepixelart/pi-code@2efd7c6921f80ef7d31e8adf3cce828fac082998,
// extensions/internal/project-root.ts (MIT, see LICENSES/pi-code.txt); repoRoot is pi-code's gitRoot.

/**
 * Where rules come from: three global directories and the nearest project directory of
 * each of three kinds, in the order their rules reach the prompt. This module is the one
 * place that knows the directory names, the search, and how each directory is addressed.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { RuleSet } from './rule-files.js'
import { realpathOr, relativeWithin } from './values.js'

/** The directories holding a project's rules, in load order. */
const PROJECT_KINDS = ['.agents', '.pi', '.claude'] as const

export interface RuleSource {
  scope: 'global' | 'project'
  /** The absolute rules directory. It exists. */
  dir: string
  /** The realpath `paths:` globs match relative to: the cwd for a global source, the
   * directory holding `.agents`, `.pi` or `.claude` for a project source. */
  globBase: string
  /** The rules directory as the model's read tool resolves it: `~/…` under home, relative
   * to the cwd for a project directory, otherwise absolute. Always with `/`. */
  pointerBase: string
}

/** One source and the rules read from it. */
export interface LoadedSource {
  source: RuleSource
  rules: RuleSet
}

export interface SourcePlan {
  /** The directories to load, in load order. */
  sources: RuleSource[]
  /** Whether project rule directories exist but were left out because the project is not trusted. */
  projectSkipped: boolean
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** The nearest directory at or above `from` holding `.git`, or undefined outside a
 * checkout. `.git` is a file in worktrees and submodules, a directory in an ordinary
 * clone; either way that directory is the root, so a worktree is bounded by itself. */
function repoRoot(from: string): string | undefined {
  let currentDir = from
  while (true) {
    if (fs.existsSync(path.join(currentDir, '.git'))) return currentDir
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) return undefined
    currentDir = parentDir
  }
}

/** Nearest `relative` directory at or above `cwd`, stopping at the repository root. Without
 * the bound, rules planted in a world-writable ancestor such as /tmp would reach every
 * session beneath it; outside a repository the extent is unknown, so only cwd counts. */
function findNearestDir(cwd: string, relative: string): string | undefined {
  const boundary = repoRoot(cwd) ?? cwd
  let currentDir = cwd
  while (true) {
    const candidate = path.join(currentDir, relative)
    if (isDirectory(candidate)) return candidate
    if (currentDir === boundary) return undefined
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) return undefined
    currentDir = parentDir
  }
}

/** Forward slashes, so a pointer reads the same on every platform. */
function slashed(target: string): string {
  return target.split(path.sep).join('/')
}

/** A global rules directory against `~` under home, by its full path elsewhere. */
function homePointerBase(dir: string, home: string): string {
  const relative = relativeWithin(home, dir)
  return relative === undefined ? dir : `~/${slashed(relative)}`
}

/**
 * The rule directories of a session, in load order: `~/.agents/rules`, `<agentDir>/rules`,
 * `~/.claude/rules`, then for each of `.agents`, `.pi` and `.claude` the nearest `<kind>/rules`
 * at or above `cwd` within the repository. Missing directories are left out, and a
 * directory that is the same location (realpath) as an earlier one is loaded only under
 * the earlier one. Project directories are left out when `trusted` is false; `projectSkipped`
 * then says whether there were any.
 */
export function resolveSources(options: { cwd: string; home: string; agentDir: string; trusted: boolean }): SourcePlan {
  const { cwd, home, agentDir, trusted } = options
  // One location loads once, under the first source that names it: `~/.claude/rules`
  // symlinked to `~/.agents/rules` shares rules between tools, it does not double them.
  // From $HOME (or a dotfiles repo rooted there) the nearest project directory is the
  // user's own global one, which is skipped the same way.
  const seen = new Set<string>()
  const firstVisit = (dir: string): boolean => {
    const real = realpathOr(dir)
    if (seen.has(real)) return false
    seen.add(real)
    return true
  }

  const cwdBase = realpathOr(cwd)
  const globalDirs = [path.join(home, '.agents', 'rules'), path.join(agentDir, 'rules'), path.join(home, '.claude', 'rules')]
  const sources: RuleSource[] = globalDirs.filter((dir) => isDirectory(dir) && firstVisit(dir)).map((dir) => ({ scope: 'global', dir, globBase: cwdBase, pointerBase: homePointerBase(dir, home) }))

  const projectDirs = PROJECT_KINDS.map((kind) => findNearestDir(cwd, path.join(kind, 'rules'))).filter((dir): dir is string => dir !== undefined && firstVisit(dir))
  if (!trusted) return { sources, projectSkipped: projectDirs.length > 0 }

  for (const dir of projectDirs) {
    sources.push({ scope: 'project', dir, globBase: realpathOr(path.dirname(path.dirname(dir))), pointerBase: slashed(path.relative(cwd, dir)) })
  }
  return { sources, projectSkipped: false }
}
