/**
 * Agent-engine flag handling shared by the one-shot provider, the session
 * pool, and the reconnect fingerprint (D19). The plugin appends
 * `--agent-engine <engine>` to the configured args unless the user already
 * set the flag; the reconnect fingerprint ignores the flag, because a saved
 * remote session loads across engines.
 *
 * @module dsh-acp-resume/engine
 */

/** Engines the `--agent-engine` flag accepts. */
export type AgentEngine = 'v1' | 'v2' | 'v3'

const FLAG = '--agent-engine'

function isEngineFlag(arg: string): boolean {
  return arg === FLAG || arg.startsWith(`${FLAG}=`)
}

/** Does `args` already carry `--agent-engine` (separate or `=` form)? */
export function hasAgentEngineFlag(args: readonly string[]): boolean {
  return args.some(isEngineFlag)
}

/**
 * `args` plus `--agent-engine <engine>`, unless the user already set the flag
 * (the user's explicit choice wins and `args` is returned unchanged).
 */
export function withAgentEngine(args: readonly string[], engine: AgentEngine): string[] {
  return hasAgentEngineFlag(args) ? [...args] : [...args, FLAG, engine]
}

/**
 * `args` without `--agent-engine` and its value (both the separate and `=`
 * forms). Elements are `unknown` because registry files are hand-editable;
 * non-strings pass through untouched.
 */
export function stripAgentEngine(args: readonly unknown[]): unknown[] {
  const kept: unknown[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === FLAG) {
      i += 1
      continue
    }
    if (typeof arg === 'string' && arg.startsWith(`${FLAG}=`)) continue
    kept.push(arg)
  }
  return kept
}
