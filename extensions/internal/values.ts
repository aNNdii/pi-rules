// escapeRegExp and realpathOr are copied from ilovepixelart/pi-code@2efd7c6921f80ef7d31e8adf3cce828fac082998,
// extensions/internal/values.ts (MIT, see LICENSES/pi-code.txt); relativeWithin is pi-rules' own.

import * as fs from 'node:fs'
import * as path from 'node:path'

/** Escape a string for literal use inside a RegExp. One copy: five private ones had
 * the same body and would have drifted the first time one of them was fixed. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/** `target` with its nearest existing ancestor resolved through symlinks and the missing
 * rest appended, so a path that does not exist yet still compares against real roots. */
export function realpathOr(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    const dir = path.dirname(target)
    if (dir === target) return target
    return path.join(realpathOr(dir), path.basename(target))
  }
}

/** `target` relative to `root`, or undefined when `target` is not inside `root`. The test is
 * for a real parent-traversal segment, not a leading `..`: a file named `..config` is inside.
 * `root` itself yields `''`. Purely lexical; resolve symlinks first where they matter. */
export function relativeWithin(root: string, target: string): string | undefined {
  const relative = path.relative(root, target)
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  return outside ? undefined : relative
}
