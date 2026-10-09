// The matching loop is adapted from ilovepixelart/pi-code@2efd7c6921f80ef7d31e8adf3cce828fac082998,
// extensions/claude-rules.ts (MIT, see LICENSES/pi-code.txt).

/**
 * Path-scoped rules waiting to attach. A rule attaches the first time a read, edit or write
 * touches a file its globs cover: its body joins that tool result. It then stays out until
 * rearm(), which a compaction or /tree calls because what attached has left the context.
 */

import { type CompiledGlob, compileGlobs, matchesCompiledGlobs } from './path-rules.js'
import type { LoadedSource } from './sources.js'
import { realpathOr, relativeWithin } from './values.js'

interface AttachTarget {
  compiled: CompiledGlob[]
  body: string
  /** The realpath the globs match relative to. */
  globBase: string
}

export class PendingRules {
  /** Every scoped rule of the session, in load order. */
  readonly #all: AttachTarget[]
  /** The rules not attached since the session started or was last re-armed. An attached
   * rule leaves this list, so the per-tool-result scan shrinks as rules attach. */
  #pending: AttachTarget[]

  /** Globs compile here, once per session, not on every tool result. */
  constructor(loaded: LoadedSource[]) {
    this.#all = loaded.flatMap(({ source, rules }) => rules.scoped.map((rule) => ({ compiled: compileGlobs(rule.paths), body: rule.body, globBase: source.globBase })))
    this.#pending = this.#all
  }

  /** How many rules can still attach. */
  get count(): number {
    return this.#pending.length
  }

  /** The bodies of the pending rules that cover `file` (absolute), in load order; they stop
   * being pending. A file outside a rule's glob base never matches it. `file` is compared by
   * realpath, so a checkout reached through a symlink still matches. */
  take(file: string): string[] {
    if (this.#pending.length === 0) return []
    const real = realpathOr(file)
    const bodies: string[] = []
    const remaining: AttachTarget[] = []
    for (const target of this.#pending) {
      const relative = relativeWithin(target.globBase, real)
      if (relative !== undefined && matchesCompiledGlobs(relative, target.compiled)) bodies.push(target.body)
      else remaining.push(target)
    }
    this.#pending = remaining
    return bodies
  }

  /** Make every rule of the session pending again. */
  rearm(): void {
    this.#pending = this.#all
  }
}
