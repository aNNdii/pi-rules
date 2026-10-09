import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveSources } from '../extensions/internal/sources.ts'

/** A fresh tree: a home directory with pi's agent dir inside, and a git repository. */
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rules-sources-')))
  const home = join(root, 'home')
  const agentDir = join(home, '.pi', 'agent')
  const repo = join(root, 'repo')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })
  const dir = (...segments: string[]): string => {
    const target = join(...segments)
    mkdirSync(target, { recursive: true })
    return target
  }
  return { root, home, agentDir, repo, dir }
}

const sourceDirs = (plan: ReturnType<typeof resolveSources>) => plan.sources.map((source) => [source.scope, source.dir])

describe('resolveSources', () => {
  it('returns the six sources in order', () => {
    const { home, agentDir, repo, dir } = fixture()
    const expected = [
      ['global', dir(home, '.agents', 'rules')],
      ['global', dir(agentDir, 'rules')],
      ['global', dir(home, '.claude', 'rules')],
      ['project', dir(repo, '.agents', 'rules')],
      ['project', dir(repo, '.pi', 'rules')],
      ['project', dir(repo, '.claude', 'rules')],
    ]
    const plan = resolveSources({ cwd: repo, home, agentDir, trusted: true })
    expect(sourceDirs(plan)).toEqual(expected)
    expect(plan.projectSkipped).toBe(false)
  })

  it('omits missing directories', () => {
    const { home, agentDir, repo, dir } = fixture()
    const pi = dir(repo, '.pi', 'rules')
    expect(sourceDirs(resolveSources({ cwd: repo, home, agentDir, trusted: true }))).toEqual([['project', pi]])
  })

  it('finds each project kind independently at its nearest ancestor', () => {
    const { home, agentDir, repo, dir } = fixture()
    const claude = dir(repo, '.claude', 'rules')
    const agents = dir(repo, 'pkg', '.agents', 'rules')
    const plan = resolveSources({ cwd: dir(repo, 'pkg', 'src'), home, agentDir, trusted: true })
    expect(plan.sources.map((source) => [source.dir, source.globBase])).toEqual([
      [agents, join(repo, 'pkg')],
      [claude, repo],
    ])
  })

  it('does not walk above the repository root', () => {
    const { root, home, agentDir, repo, dir } = fixture()
    dir(root, '.agents', 'rules')
    expect(resolveSources({ cwd: dir(repo, 'src'), home, agentDir, trusted: true }).sources).toEqual([])
  })

  it('stops at a .git file', () => {
    const { home, agentDir, repo, dir } = fixture()
    dir(repo, '.agents', 'rules')
    const worktree = dir(repo, 'wt')
    writeFileSync(join(worktree, '.git'), 'gitdir: ../.git/worktrees/wt\n')
    expect(resolveSources({ cwd: worktree, home, agentDir, trusted: true }).sources).toEqual([])
  })

  it('checks only the cwd outside a repository', () => {
    const { root, home, agentDir, dir } = fixture()
    const outside = dir(root, 'plain')
    dir(outside, '.claude', 'rules')
    expect(resolveSources({ cwd: dir(outside, 'sub'), home, agentDir, trusted: true }).sources).toEqual([])
    expect(sourceDirs(resolveSources({ cwd: outside, home, agentDir, trusted: true }))).toEqual([['project', join(outside, '.claude', 'rules')]])
  })

  it('skips a project directory that is a global directory', () => {
    const { home, agentDir, dir } = fixture()
    const agents = dir(home, '.agents', 'rules')
    const claude = dir(home, '.claude', 'rules')
    const expected = [
      ['global', agents],
      ['global', claude],
    ]
    expect(sourceDirs(resolveSources({ cwd: home, home, agentDir, trusted: true }))).toEqual(expected)
    // A dotfiles repository rooted at home, session in a subdirectory.
    mkdirSync(join(home, '.git'))
    expect(sourceDirs(resolveSources({ cwd: dir(home, 'sub'), home, agentDir, trusted: true }))).toEqual(expected)
  })

  it('uses agentDir for the global .pi source', () => {
    const { root, home, repo } = fixture()
    const agentDir = join(root, 'elsewhere', 'agent')
    mkdirSync(join(agentDir, 'rules'), { recursive: true })
    const plan = resolveSources({ cwd: repo, home, agentDir, trusted: true })
    expect(plan.sources).toEqual([{ scope: 'global', dir: join(agentDir, 'rules'), globBase: repo, pointerBase: join(agentDir, 'rules') }])
  })

  it('writes pointer bases against ~ and the cwd', () => {
    const { home, agentDir, repo, dir } = fixture()
    dir(home, '.agents', 'rules')
    dir(agentDir, 'rules')
    dir(repo, '.claude', 'rules')
    dir(repo, 'pkg', '.pi', 'rules')
    const plan = resolveSources({ cwd: dir(repo, 'pkg'), home, agentDir, trusted: true })
    expect(plan.sources.map((source) => source.pointerBase)).toEqual(['~/.agents/rules', '~/.pi/agent/rules', '.pi/rules', '../.claude/rules'])
  })

  it('matches global globs against the cwd', () => {
    const { home, agentDir, repo, dir } = fixture()
    dir(home, '.claude', 'rules')
    const cwd = dir(repo, 'pkg')
    expect(resolveSources({ cwd, home, agentDir, trusted: true }).sources[0].globBase).toBe(cwd)
  })

  it('skips project sources when untrusted and reports it', () => {
    const { home, agentDir, repo, dir } = fixture()
    const agents = dir(home, '.agents', 'rules')
    expect(resolveSources({ cwd: repo, home, agentDir, trusted: false })).toEqual({ sources: [{ scope: 'global', dir: agents, globBase: repo, pointerBase: '~/.agents/rules' }], projectSkipped: false })
    dir(repo, '.pi', 'rules')
    const plan = resolveSources({ cwd: repo, home, agentDir, trusted: false })
    expect(sourceDirs(plan)).toEqual([['global', agents]])
    expect(plan.projectSkipped).toBe(true)
  })

  it('loads a directory reached through a symlink to an earlier one once', () => {
    const { home, agentDir, repo, dir } = fixture()
    const globalAgents = dir(home, '.agents', 'rules')
    mkdirSync(join(home, '.claude'))
    symlinkSync(globalAgents, join(home, '.claude', 'rules'))
    symlinkSync(globalAgents, join(agentDir, 'rules'))
    const projectAgents = dir(repo, '.agents', 'rules')
    mkdirSync(join(repo, '.claude'))
    symlinkSync(join('..', '.agents', 'rules'), join(repo, '.claude', 'rules'))
    expect(sourceDirs(resolveSources({ cwd: repo, home, agentDir, trusted: true }))).toEqual([
      ['global', globalAgents],
      ['project', projectAgents],
    ])
  })

  it('does not report a skip for an untrusted session in home', () => {
    const { home, agentDir, dir } = fixture()
    dir(home, '.agents', 'rules')
    expect(resolveSources({ cwd: home, home, agentDir, trusted: false }).projectSkipped).toBe(false)
  })
})
