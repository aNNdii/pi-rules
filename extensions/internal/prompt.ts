// Adapted from ilovepixelart/pi-code@2efd7c6921f80ef7d31e8adf3cce828fac082998, extensions/claude-rules.ts (MIT, see LICENSES/pi-code.txt).
// Changes: rules come from several sources per scope; a section gathers all sources of its scope;
// the before_agent_start handling lives here as applyRules.

/**
 * What a session's rules add to the system prompt, and how they get there. Unscoped rules
 * become context files, one per rule file, so a provider that rebuilds the prompt from pi's
 * options keeps them; path-scoped rules become pointers in the appended instructions. For a
 * prompt that is not rebuilt from the options, both are appended as plain text instead.
 */

import type { RuleSet } from './rule-files.js'
import type { LoadedSource, RuleSource } from './sources.js'

export interface ContextFile {
  path: string
  content: string
}

/** The prompt options this module edits. pi sets `forceSystemPrompt` from 0.86, where
 * a handler that returned a prompt forced it for the run. */
export interface PromptOptions {
  contextFiles?: ContextFile[]
  appendSystemPrompt?: string
  forceSystemPrompt?: string
}

/** The parts of pi's before_agent_start event this module reads and edits. */
export interface PromptEvent {
  systemPrompt: string
  systemPromptOptions?: PromptOptions
}

/** What a session's rules add to the prompt, built once at session start. */
export interface PromptRules {
  /** The unscoped rules, each under its own file. */
  contextFiles: ContextFile[]
  /** The pointer blocks of the scoped rules. Not a file, so they travel as appended instructions. */
  pointers: string
  /** Both as text, for a prompt that is not rebuilt from its options. Empty without rules. */
  fallbackText: string
}

export const NO_PROMPT_RULES: PromptRules = { contextFiles: [], pointers: '', fallbackText: '' }

const POINTER_FOOTER = 'Read the relevant rule file with the read tool before working on the files it covers.'

/** The pointer block for a rule set's path-scoped rules, written against `base` so the
 * model's read resolves. */
function scopedPointers(rules: RuleSet, base: string): string {
  const lines = rules.scoped.map((rule) => `- ${base}/${rule.rel} — applies when working on: ${rule.paths.join(', ')}`)
  return `Path-scoped rules, available in ${base}/:\n\n${lines.join('\n')}\n\n${POINTER_FOOTER}`
}

function pointerBlocks(loaded: LoadedSource[]): string[] {
  return loaded.filter(({ rules }) => rules.scoped.length > 0).map(({ source, rules }) => scopedPointers(rules, source.pointerBase))
}

/** The fallback section for one scope: unscoped bodies, then pointer blocks; empty without rules. */
function rulesSection(title: string, loaded: LoadedSource[]): string {
  const bodies = loaded.flatMap(({ rules }) => rules.unscoped.map((rule) => rule.body))
  const pointers = pointerBlocks(loaded)
  if (bodies.length === 0 && pointers.length === 0) return ''
  let section = `\n\n## ${title}`
  if (bodies.length > 0) section += `\n\nThese rules always apply:\n\n${bodies.join('\n\n')}`
  for (const block of pointers) section += `\n\n${block}`
  return section
}

/** The prompt additions for `loaded`, in its order; the fallback text puts global rules
 * before project rules, as user-level instructions come first. */
export function promptRules(loaded: LoadedSource[]): PromptRules {
  const inScope = (scope: RuleSource['scope']): LoadedSource[] => loaded.filter(({ source }) => source.scope === scope)
  return {
    contextFiles: loaded.flatMap(({ rules }) => rules.unscoped.map((rule) => ({ path: rule.file, content: rule.body }))),
    pointers: pointerBlocks(loaded).join('\n\n'),
    fallbackText: rulesSection('Global Rules', inScope('global')) + rulesSection('Project Rules', inScope('project')),
  }
}

/** Add the rules to the options, returning how to take exactly this edit out again. */
function addToOptions(options: PromptOptions, contextFiles: ContextFile[], rules: PromptRules): () => void {
  const append = options.appendSystemPrompt
  // Copies: the options belong to one run and these entries serve every turn.
  contextFiles.push(...rules.contextFiles.map((entry) => ({ ...entry })))
  if (rules.pointers.length > 0) options.appendSystemPrompt = append ? `${append}\n\n${rules.pointers}` : rules.pointers
  return () => {
    contextFiles.splice(contextFiles.length - rules.contextFiles.length, rules.contextFiles.length)
    if (rules.pointers.length > 0) options.appendSystemPrompt = append
  }
}

/**
 * Add the rules to a run's system prompt, as a before_agent_start handler does. Returns the
 * prompt the handler must return, or undefined when there is nothing to return: no rules, or
 * pi rebuilt `event.systemPrompt` from the edited options (pi >= 0.86). A returned prompt
 * forces it for the run, so returning an unchanged prompt is not the same as returning nothing.
 */
export function applyRules(event: PromptEvent, rules: PromptRules): { systemPrompt: string } | undefined {
  if (rules.fallbackText.length === 0) return undefined
  const options = event.systemPromptOptions
  const contextFiles = options?.contextFiles
  const before = event.systemPrompt
  if (options !== undefined && contextFiles !== undefined) {
    const undo = addToOptions(options, contextFiles, rules)
    if (event.systemPrompt !== before) return undefined
    // A prompt an earlier handler forced stays fixed, but the options are that run's own
    // copy and still what a rebuilding provider reads, so they keep the rules. An older pi
    // reuses the options object next turn, so there the edit is undone.
    if (options.forceSystemPrompt === undefined) undo()
  }
  return { systemPrompt: before + rules.fallbackText }
}
