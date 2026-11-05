/**
 * Child-process CLI flag handling shared by the one-shot provider, the
 * session pool, and the reconnect fingerprint (D19). The plugin appends a few
 * spawn-level flags to the configured args unless the user already set them:
 * `--agent-engine <engine>` (the KAS engine selector) and, when configured,
 * `--model <id>` / `--effort <level>` (model routing, off by default so the
 * server keeps auto-routing). The reconnect fingerprint ignores all three:
 * a saved remote session loads across engines, and `auto` already swaps models
 * per task inside a session, so a model/effort difference is not "a different
 * agent" the way a different command would be.
 *
 * @module dsh-acp-resume/engine
 */

/** Engines the `--agent-engine` flag accepts. */
export type AgentEngine = 'v1' | 'v2' | 'v3'

const ENGINE_FLAG = '--agent-engine'
const MODEL_FLAG = '--model'
const EFFORT_FLAG = '--effort'

/**
 * Flags that are spawn-level choices, not part of a chat's identity: the
 * reconnect fingerprint strips these (and their values) before comparing
 * args, and {@link buildChildArgs} refuses to append any one the user already
 * set explicitly. Both the separate (`--model x`) and `=` (`--model=x`) forms
 * are recognized.
 */
const VOLATILE_FLAGS: readonly string[] = [ENGINE_FLAG, MODEL_FLAG, EFFORT_FLAG]

/** Does `arg` set `flag` (separate `--flag` or joined `--flag=value`)? */
function matchesFlag(arg: string, flag: string): boolean {
  return arg === flag || arg.startsWith(`${flag}=`)
}

/** Does `args` already carry `flag` (separate or `=` form)? */
function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some(arg => matchesFlag(arg, flag))
}

/** Does `args` already carry `--agent-engine` (separate or `=` form)? */
export function hasAgentEngineFlag(args: readonly string[]): boolean {
  return hasFlag(args, ENGINE_FLAG)
}

/**
 * Child spawn flags added on top of the configured args. Each is appended only
 * when the user did not already set it in `args`.
 */
export interface ChildFlags {
  /** The KAS engine selector appended as `--agent-engine <engine>`. */
  readonly engine: AgentEngine
  /** When set, the model id appended as `--model <id>` (otherwise server auto-routes). */
  readonly model?: string
  /** When set, the effort level appended as `--effort <level>`. */
  readonly effort?: string
}

/** Append `--flag value` when `value` is set and `args` does not already carry `--flag`. */
function appendFlag(args: string[], flag: string, value: string | undefined): void {
  if (value === undefined || value === '') return
  if (hasFlag(args, flag)) return
  args.push(flag, value)
}

/**
 * `args` plus the spawn-level flags (`--agent-engine`, and `--model` /
 * `--effort` when configured), each skipped when the user already set it so an
 * explicit choice in `args` always wins.
 */
export function buildChildArgs(args: readonly string[], flags: ChildFlags): string[] {
  const next = [...args]
  appendFlag(next, ENGINE_FLAG, flags.engine)
  appendFlag(next, MODEL_FLAG, flags.model)
  appendFlag(next, EFFORT_FLAG, flags.effort)
  return next
}

/**
 * `args` plus `--agent-engine <engine>`, unless the user already set the flag.
 * Thin wrapper over {@link buildChildArgs} for callers that only pick the engine.
 */
export function withAgentEngine(args: readonly string[], engine: AgentEngine): string[] {
  return buildChildArgs(args, { engine })
}

/**
 * `args` without the volatile spawn-level flags (`--agent-engine`, `--model`,
 * `--effort`) and their values, in both the separate and `=` forms. Elements
 * are `unknown` because registry files are hand-editable; non-strings pass
 * through untouched.
 */
export function stripVolatileFlags(args: readonly unknown[]): unknown[] {
  const kept: unknown[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (typeof arg === 'string' && VOLATILE_FLAGS.includes(arg)) {
      // A bare `--flag` consumes the next element as its value.
      i += 1
      continue
    }
    if (typeof arg === 'string' && VOLATILE_FLAGS.some(flag => arg.startsWith(`${flag}=`))) continue
    kept.push(arg)
  }
  return kept
}

/**
 * Backwards-compatible alias of {@link stripVolatileFlags} (the fingerprint now
 * strips model/effort too, D19 revision 2026-11-05).
 */
export const stripAgentEngine = stripVolatileFlags
