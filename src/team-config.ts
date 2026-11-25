/**
 * Workspace team configuration (D27): role blueprints and workflow templates
 * read from `.agents/acp-team.yml`. The file is looked up from a start
 * directory upward, the start counting as level 1, at most
 * {@link TEAM_CONFIG_SEARCH_LEVELS} levels; the directory holding `.agents/`
 * is the workspace root, against which relative role `cwd`s resolve. A
 * missing file is "no workspace configuration" without a warning; an
 * unreadable, unparsable, or invalid file is reported once through `onWarn`
 * and also treated as no configuration. Blueprints only: no instance state
 * lives here (the roster holds instances).
 *
 * @module dsh-acp-resume/team-config
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'

/** Path of the team file below a workspace root. */
export const TEAM_CONFIG_FILE = join('.agents', 'acp-team.yml')
/** Directories searched, the start directory included. */
export const TEAM_CONFIG_SEARCH_LEVELS = 3

/** Role names: Unicode letters and digits (any script, e.g. 调研员), `_` and `-`; 1–32 code points. */
const NAME_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u
/** Template params and step ids: the names a `{name}` placeholder can use. */
const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

/** One role a workspace can instantiate. */
export interface RoleBlueprint {
  readonly name: string
  /** Backend name; absent means the default backend. Checked when the role is provisioned. */
  readonly backend?: string
  /** Absolute working directory of the role's chat (a relative file value is resolved against the workspace root). */
  readonly cwd: string
  /**
   * One sentence for OTHERS (D32): what this role does, shown to the
   * dispatcher choosing a role (`acp_team_list`) and to teammates in their
   * seeding context. Absent when unset or blank. Contrast `seeding`, the
   * role's full brief to itself.
   */
  readonly summary?: string
  /** First message sent to a freshly provisioned chat, for the role ITSELF (its full brief); absent means none. */
  readonly seeding?: string
}

/** A role in a parallel step, optionally with its own prompt. */
export interface RoleRef {
  readonly role: string
  readonly prompt?: string
}

/** Run every listed role at once; consecutive steps run in order. */
export interface ParallelStep {
  readonly id: string
  readonly parallel: readonly RoleRef[]
  readonly prompt?: string
}

/**
 * Combine the previous results: hand them back to the model (last step only),
 * or send them to one role, whose answer becomes this step's result. `prompt`
 * is the merging role's instruction.
 */
export interface MergeStep {
  readonly id: string
  readonly merge: { readonly mode: 'return_to_model' } | { readonly mode: 'role'; readonly role: string; readonly prompt?: string }
}

export type Step = ParallelStep | MergeStep

export interface Template {
  readonly name: string
  readonly description: string
  readonly params: readonly string[]
  readonly steps: readonly Step[]
}

export interface TeamConfig {
  /** Directory holding `.agents/acp-team.yml`. */
  readonly root: string
  readonly roles: readonly RoleBlueprint[]
  readonly templates: readonly Template[]
}

/** Find `.agents/acp-team.yml` from `start` upward; undefined when no searched directory has one. */
export function findTeamConfig(start: string): string | undefined {
  let dir = resolve(start)
  for (let level = 0; level < TEAM_CONFIG_SEARCH_LEVELS; level += 1) {
    const candidate = join(dir, TEAM_CONFIG_FILE)
    try {
      readFileSync(candidate)
      return candidate
    } catch { /* not here */ }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Read the workspace team configuration seen from `start`.
 * @param start - the calling session's working directory.
 * @param onWarn - receives one message when a found file cannot be used.
 * @returns the configuration, or undefined for none (missing or unusable).
 */
export function loadTeamConfig(start: string, onWarn?: (message: string) => void): TeamConfig | undefined {
  const read = readTeamConfig(start)
  if (read.kind === 'invalid') onWarn?.(`acp-resume: workspace team config ${read.path} is not usable (${read.error}); continuing without workspace roles`)
  return read.kind === 'ok' ? read.config : undefined
}

/** The outcome of looking up the workspace team file: none found, usable, or found but invalid (with the reason). */
export type TeamConfigRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly path: string; readonly config: TeamConfig }
  | { readonly kind: 'invalid'; readonly path: string; readonly error: string }

/**
 * Look up and parse the workspace team file seen from `start`, keeping the
 * reason an existing file is unusable, so model-facing errors can say what is
 * wrong instead of implying there is no file. Never throws; never warns.
 */
export function readTeamConfig(start: string): TeamConfigRead {
  const path = findTeamConfig(start)
  if (path === undefined) return { kind: 'none' }
  try {
    return { kind: 'ok', path, config: parseTeamConfig(readFileSync(path, 'utf8'), dirname(dirname(path))) }
  } catch (error: unknown) {
    return { kind: 'invalid', path, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The team context the plugin prepends to a role's seeding (D32): who the
 * role is, its teammates (every OTHER role, with its summary when set), and
 * how to ask them for something. English on purpose: system text, whatever
 * the user's language. A one-role team leaves out the teammates lines.
 */
export function teamContext(role: string, roles: readonly RoleBlueprint[]): string {
  const others = roles.filter(r => r.name !== role)
  return [
    `You are the team role "${role}" in this workspace's ACP team.`,
    ...(others.length === 0 ? [] : [
      'Your teammates (reached through the dispatcher; workers do not talk to each other directly):',
      ...others.map(r => r.summary === undefined ? `- ${r.name}` : `- ${r.name}: ${r.summary}`),
    ]),
    'When you need something from a teammate, state the request explicitly in your answer; the dispatcher relays it.',
  ].join('\n')
}

/** A role's seeding message with the team context in front; the user's seeding follows verbatim after a blank line. */
export function seedingWithTeam(blueprint: RoleBlueprint & { readonly seeding: string }, roles: readonly RoleBlueprint[]): string {
  return `${teamContext(blueprint.name, roles)}\n\n${blueprint.seeding}`
}

/**
 * One line naming what the workspace offers, for `acp_chat_list`:
 * `workspace roles: a, b; templates: t1(p1, p2), t2()`, or
 * `workspace config error: <reason>`; undefined when there is no team file.
 */
export function describeTeamConfig(read: TeamConfigRead): string | undefined {
  if (read.kind === 'none') return undefined
  if (read.kind === 'invalid') return `workspace config error: ${read.path}: ${read.error}`
  const roles = read.config.roles.map(r => r.name).join(', ') || '(none)'
  const templates = read.config.templates.map(t => `${t.name}(${t.params.join(', ')})`).join(', ') || '(none)'
  return `workspace roles: ${roles}; templates: ${templates}`
}

/**
 * Parse and validate team file text.
 * @param text - YAML source.
 * @param root - workspace root for relative role `cwd`s.
 * @throws on a YAML error or an invalid shape or reference, naming the offending field.
 */
export function parseTeamConfig(text: string, root: string): TeamConfig {
  const doc: unknown = parse(text)
  const top = doc === null || doc === undefined ? {} : record(doc, 'file', ['version', 'roles', 'templates'])
  if (top['version'] !== undefined && top['version'] !== 1) throw new Error('version must be 1 when given')
  const roles = list(top['roles'], 'roles').map((raw, i) => role(record(raw, `roles[${i}]`, ['name', 'backend', 'cwd', 'summary', 'seeding']), `roles[${i}]`, root))
  unique(roles.map(r => r.name), 'role name')
  const known = new Set(roles.map(r => r.name))
  const templates = list(top['templates'], 'templates').map((raw, i) => template(record(raw, `templates[${i}]`, ['name', 'description', 'params', 'steps']), `templates[${i}]`, known))
  unique(templates.map(t => t.name), 'template name')
  return { root, roles, templates }
}

function role(raw: Record<string, unknown>, at: string, root: string): RoleBlueprint {
  const name = str(raw['name'], `${at}.name`, true) as string
  if (!NAME_PATTERN.test(name)) throw new Error(`${at}.name must be 1–32 letters, digits, _ or - (any script)`)
  const backend = str(raw['backend'], `${at}.backend`)
  const cwd = str(raw['cwd'], `${at}.cwd`)
  const seeding = str(raw['seeding'], `${at}.seeding`)
  // One line: a summary is shown in lists, so inner whitespace (newlines included) collapses.
  const summary = str(raw['summary'], `${at}.summary`)?.replace(/\s+/g, ' ').trim()
  return {
    name,
    cwd: resolve(root, cwd ?? '.'),
    ...(backend === undefined ? {} : { backend }),
    ...(summary === undefined || summary === '' ? {} : { summary }),
    ...(seeding === undefined || seeding.trim() === '' ? {} : { seeding }),
  }
}

function template(raw: Record<string, unknown>, at: string, roles: ReadonlySet<string>): Template {
  const name = str(raw['name'], `${at}.name`, true) as string
  const params = list(raw['params'], `${at}.params`).map((p, i) => placeholderName(str(p, `${at}.params[${i}]`, true) as string, `${at}.params[${i}]`))
  unique(params, `param in ${at}`)
  const steps = list(raw['steps'], `${at}.steps`).map((s, i) => step(record(s, `${at}.steps[${i}]`, ['id', 'parallel', 'prompt', 'merge']), `${at}.steps[${i}]`, roles))
  if (steps.length === 0) throw new Error(`${at}.steps must not be empty`)
  unique(steps.map(s => s.id), `step id in ${at}`)
  // One namespace for {name} placeholders: a param and a step id may not share a name.
  for (const s of steps) if (params.includes(s.id)) throw new Error(`${at}: step id ${s.id} collides with a param of the same name`)
  steps.forEach((s, i) => {
    if ('merge' in s && s.merge.mode === 'return_to_model' && i !== steps.length - 1) {
      throw new Error(`${at}.steps[${i}]: a return_to_model merge must be the last step`)
    }
  })
  return { name, description: str(raw['description'], `${at}.description`) ?? '', params, steps }
}

function step(raw: Record<string, unknown>, at: string, roles: ReadonlySet<string>): Step {
  const id = placeholderName(str(raw['id'], `${at}.id`, true) as string, `${at}.id`)
  const knownRole = (name: string, where: string): string => {
    if (!roles.has(name)) throw new Error(`${where} names unknown role ${name}`)
    return name
  }
  if (raw['merge'] !== undefined) {
    // A merge step is only a merge: a parallel list or a step-level prompt beside it would be dropped silently.
    if (raw['parallel'] !== undefined) throw new Error(`${at} has both merge and parallel; a step is one or the other`)
    if (raw['prompt'] !== undefined) throw new Error(`${at} is a merge step; put its instruction in merge.prompt`)
    const merge = record(raw['merge'], `${at}.merge`, ['mode', 'role', 'prompt'])
    const mode = merge['mode']
    if (mode === 'return_to_model') return { id, merge: { mode } }
    if (mode === 'role') {
      const prompt = str(merge['prompt'], `${at}.merge.prompt`)
      return { id, merge: { mode, role: knownRole(str(merge['role'], `${at}.merge.role`, true) as string, `${at}.merge.role`), ...(prompt === undefined ? {} : { prompt }) } }
    }
    throw new Error(`${at}.merge.mode must be return_to_model or role`)
  }
  const parallel = list(raw['parallel'], `${at}.parallel`).map((ref, i): RoleRef => {
    const where = `${at}.parallel[${i}]`
    if (typeof ref === 'string') return { role: knownRole(ref, where) }
    const fields = record(ref, where, ['role', 'prompt'])
    const prompt = str(fields['prompt'], `${where}.prompt`)
    return { role: knownRole(str(fields['role'], `${where}.role`, true) as string, where), ...(prompt === undefined ? {} : { prompt }) }
  })
  if (parallel.length === 0) throw new Error(`${at} needs a non-empty parallel list or a merge`)
  // A role serves one prompt at a time (D6 single flight): listing it twice in one step would fail the second.
  unique(parallel.map(r => r.role), `role in ${at}.parallel`)
  const prompt = str(raw['prompt'], `${at}.prompt`)
  return { id, parallel, ...(prompt === undefined ? {} : { prompt }) }
}

function placeholderName(name: string, at: string): string {
  if (!PLACEHOLDER_NAME.test(name)) throw new Error(`${at} must match [A-Za-z_][A-Za-z0-9_-]{0,63}`)
  return name
}

/** A mapping with only `allowed` keys: an unknown key (a typo such as `seed` for `seeding`) is an error, not a silent no-op. */
function record(value: unknown, at: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${at} must be a mapping`)
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${at} has unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}; allowed: ${allowed.join(', ')}`)
  return value as Record<string, unknown>
}

function list(value: unknown, at: string): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${at} must be a list`)
  return value
}

function str(value: unknown, at: string, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${at} is required`)
    return undefined
  }
  if (typeof value !== 'string' || (required && value.trim() === '')) throw new Error(`${at} must be a${required ? ' non-empty' : ''} string`)
  return value
}

function unique(names: readonly string[], what: string): void {
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) throw new Error(`duplicate ${what} ${name}`)
    seen.add(name)
  }
}
