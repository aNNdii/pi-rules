// Adapted from ilovepixelart/pi-code@2efd7c6921f80ef7d31e8adf3cce828fac082998, extensions/claude-rules.ts (MIT, see LICENSES/pi-code.txt).
// Changes: six sources instead of one; project rules follow pi's trust decision; unreadable rules
// are reported; no claudeMdExcludes, managed settings, instruction-events bus or CLAUDE_* switches.

/**
 * Rules Extension
 *
 * Loads rule files from `~/.agents/rules`, `<agentDir>/rules`, `~/.claude/rules` and the
 * nearest project `.agents/rules`, `.pi/rules` and `.claude/rules`, the way Claude Code
 * loads `.claude/rules`:
 * - Rules without `paths:` frontmatter always apply and join the system prompt.
 * - Rules with `paths:` frontmatter are listed as pointers, and their body is appended to
 *   the result of the first read/edit/write that touches a file their globs cover.
 *
 * This module only connects pi's events to internal/sources (where rules are),
 * internal/rule-files (what they say), internal/prompt (the system prompt) and
 * internal/attach (the tool results).
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from '@earendil-works/pi-coding-agent'

import { PendingRules } from './internal/attach.js'
import { applyRules, NO_PROMPT_RULES, type PromptRules, promptRules } from './internal/prompt.js'
import { readRules } from './internal/rule-files.js'
import { type LoadedSource, resolveSources } from './internal/sources.js'
import { fileToolTarget } from './internal/tool-target.js'

export { parseFrontmatter } from './internal/rule-files.js'

/** Tell the user what loaded and what did not. */
function reportLoad(ui: ExtensionContext['ui'], loaded: LoadedSource[], projectSkipped: boolean): void {
  const count = (scope: 'global' | 'project'): number => loaded.filter(({ source }) => source.scope === scope).reduce((sum, { rules }) => sum + rules.unscoped.length + rules.scoped.length, 0)
  const globalCount = count('global')
  const projectCount = count('project')
  if (globalCount + projectCount > 0) ui.notify(`Rules loaded: global ${globalCount}, project ${projectCount}`, 'info')
  const unreadable = loaded.flatMap(({ rules }) => rules.unreadable)
  if (unreadable.length > 0) ui.notify(`Rules skipped, cannot read: ${unreadable.join(', ')}`, 'warning')
  if (projectSkipped) ui.notify('Project rules skipped: project is not trusted', 'warning')
}

export default function rulesExtension(pi: ExtensionAPI) {
  let rules: PromptRules = NO_PROMPT_RULES
  let pending = new PendingRules([])

  pi.on('session_start', async (_event, ctx) => {
    // Project rules are repository text landing in the system prompt. pi loads AGENTS.md
    // regardless of trust, so rules do too, unless pi decided the project is not trusted.
    const trusted = ctx.isProjectTrusted?.() === true
    const plan = resolveSources({ cwd: ctx.cwd, home: os.homedir(), agentDir: getAgentDir(), trusted })
    const loaded = plan.sources.map((source) => ({ source, rules: readRules(source.dir) }))
    rules = promptRules(loaded)
    pending = new PendingRules(loaded)
    reportLoad(ctx.ui, loaded, plan.projectSkipped)
  })

  pi.on('before_agent_start', async (event) => applyRules(event, rules))

  // Compaction folds the tool results that carried attached rules into a summary, and /tree
  // moves to a branch that never had them.
  const rearm = (): void => pending.rearm()
  pi.on('session_compact', rearm)
  pi.on('session_tree', rearm)

  pi.on('tool_result', async (event, ctx) => {
    if (pending.count === 0) return
    const target = fileToolTarget(event)
    if (target === undefined) return
    const bodies = pending.take(path.resolve(ctx.cwd, target))
    if (bodies.length === 0) return
    return { content: [...event.content, ...bodies.map((text) => ({ type: 'text' as const, text }))] }
  })
}
