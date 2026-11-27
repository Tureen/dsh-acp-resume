/** Validation messages and backend default rules shared by the Host and the settings editor (D45 / D48). @module */
export const WORKFLOW_REQUIRES_ROLES = 'acp-resume: workflow: true requires roles: true; the workflow engine dispatches to roles. Set roles: true, or set workflow: false'
export const OVERRIDE_REQUIRES_RULES = 'dispatcherPrompt.overrideRules requires nonempty extraRules to replace the built-in dispatch rules'

/** Default ACP session effort levels (Kiro and other ACP backends, D34). */
export const KIRO_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** Antigravity CLI session effort levels (D40). */
export const AGY_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const

/** Backend effort family used to determine valid effort values (D40 / D48). */
export type EffortKind = 'kiro' | 'agy' | 'codex'

/** Live per-backend default override entry stored under `backendDefaults.<id>` (D48). */
export interface BackendDefault {
  readonly model?: string
  readonly effort?: string
}

/** Identify a built-in CLI from its command string or path (stripping Windows executable extensions). */
export function commandKind(command: string): 'kiro-cli' | 'agy' | 'codex' | undefined {
  const base = command.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '')
  return base === 'kiro-cli' || base === 'agy' || base === 'codex' ? base : undefined
}

/** Resolve the effort family for a backend by protocol and command (D40 / D48). */
export function effortKindFor(backend: { readonly protocol?: 'acp' | 'codex'; readonly command?: string }): EffortKind {
  if (backend.protocol === 'codex') return 'codex'
  const cli = backend.command === undefined ? undefined : commandKind(backend.command)
  if (cli === 'codex') return 'codex'
  if (cli === 'agy') return 'agy'
  return 'kiro'
}

/** Allowed effort dropdown options for a backend family, or undefined for Codex free-form input. */
export function effortLevelsFor(kind: EffortKind): readonly string[] | undefined {
  if (kind === 'codex') return undefined
  return kind === 'agy' ? AGY_EFFORT_LEVELS : KIRO_EFFORT_LEVELS
}

/** Resolve effective backend defaults: live `backendDefaults[id]` takes precedence over static profile values (D48). */
export function resolveEffectiveBackendDefault(
  live: BackendDefault | undefined,
  staticModel: string | undefined,
  staticEffort: string | undefined,
): { readonly model?: string; readonly effort?: string } {
  const model = (live?.model?.trim() || undefined) ?? staticModel
  const effort = (live?.effort?.trim() || undefined) ?? staticEffort
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }
}

/** Validate `backendDefaults.<id>.effort` before persisting or applying; returns an error message or undefined. */
export function validateBackendDefaultEffort(backendId: string, effort: string | undefined, kind: EffortKind): string | undefined {
  if (effort === undefined || effort === '') return undefined
  const levels = effortLevelsFor(kind)
  if (levels === undefined) return undefined
  if (levels.includes(effort)) return undefined
  return `acp-resume: backendDefaults.${backendId}.effort ${JSON.stringify(effort)} is not a valid effort level${kind === 'agy' ? ' for agy' : ''}; it must be one of ${levels.join(', ')}`
}
