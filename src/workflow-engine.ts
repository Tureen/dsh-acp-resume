/**
 * Workflow engine (D27, second round): runs one workspace template over the
 * role pool. Steps run in declaration order. A `parallel` step sends its
 * prompt to every listed role at once through role auto-provisioning; a role
 * that fails (rejected send, or a turn that did not complete) is recorded as
 * `{ error }` while the others carry on, and only a step whose every role
 * failed stops the run. Prompts fill `{param}` from the call's params and
 * `{stepId}` from an earlier step's rendered results; a prompt that names no
 * earlier step gets the previous step's results appended. A `role` merge
 * sends every earlier result to the merging role and records its answer; a
 * `return_to_model` merge (last step only) just ends the run with the
 * collected results. Cancellation is the caller's signal, passed to every
 * send, so each in-flight turn settles through the D6 cancel path. The
 * engine holds no state between runs.
 *
 * @module dsh-acp-resume/workflow-engine
 */

import type { PoolSendResult, RoleCallContext } from './pool.js'
import type { Step, Template } from './team-config.js'
import type { MemberOutcome } from './workflow-record.js'
import type { PermissionRequestResolver } from './permission-request.js'

/**
 * Optional run observer (progress records, job progress). Called around every
 * step and every role send; a throwing observer is contained.
 */
export interface WorkflowObserver {
  stepStart?(stepId: string): void
  /** A role member is about to be sent to; returns its member seq. */
  memberStart?(role: string, stepId: string): number
  memberEnd?(seq: number, outcome: MemberOutcome): void
}

/** What the engine needs from the pool. */
export interface WorkflowPool {
  sendByRole(role: string, message: string, context: RoleCallContext, signal?: AbortSignal, hooks?: { readonly permissionResolver?: PermissionRequestResolver }): Promise<PoolSendResult>
}

/** One role's outcome in a parallel step: its answer, or why it has none. */
export type RoleResult = string | { readonly error: string }

export type StepResult =
  | { readonly id: string; readonly results: Readonly<Record<string, RoleResult>> }
  | { readonly id: string; readonly result: string }
  | { readonly id: string; readonly mode: 'return_to_model' }

/** The run's structured output (the job output, as JSON). */
export interface WorkflowResult {
  readonly template: string
  readonly status: 'completed' | 'failed' | 'aborted'
  /** Why the run stopped early; absent when completed. */
  readonly error?: string
  readonly steps: readonly StepResult[]
}

/**
 * Check the call's params against the template: every declared param present,
 * nothing undeclared, values strings or finite numbers or booleans.
 * @returns the params as strings.
 * @throws a model-facing reason naming the offending param.
 */
export function bindParams(template: Template, params: unknown): Readonly<Record<string, string>> {
  const given = params === undefined || params === null ? {} : params
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error('params must be an object of name → value')
  // Null prototype: a declared param named `constructor` or `__proto__` must not resolve to an Object.prototype member.
  const bound: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [name, value] of Object.entries(given)) {
    if (!template.params.includes(name)) {
      throw new Error(`template ${template.name} has no param ${name}; its params: ${template.params.join(', ') || '(none)'}`)
    }
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) bound[name] = String(value)
    else throw new Error(`param ${name} must be a string, number, or boolean`)
  }
  const missing = template.params.filter(name => !Object.hasOwn(bound, name))
  if (missing.length > 0) throw new Error(`template ${template.name} needs params: ${missing.join(', ')}`)
  return bound
}

/** Render a step's results as prompt context. */
export function renderStep(step: StepResult): string {
  if ('results' in step) {
    const parts = Object.entries(step.results).map(([role, result]) => typeof result === 'string'
      ? `#### ${role}\n${result}`
      : `#### ${role} (failed)\n${result.error}`)
    return `### Step ${step.id}\n${parts.join('\n\n')}`
  }
  if ('result' in step) return `### Step ${step.id}\n${step.result}`
  return ''
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}/g

/**
 * Fill `{name}` placeholders: params first, then earlier step results. Unknown
 * names stay as written (prompts may hold literal braces). Without any `{stepId}`
 * reference, the previous step's results are appended.
 */
export function fillPrompt(prompt: string, params: Readonly<Record<string, string>>, done: readonly StepResult[]): string {
  const byId = new Map(done.map(step => [step.id, step]))
  let referencedStep = false
  const filled = prompt.replace(PLACEHOLDER, (whole, name: string) => {
    // Own params only: `{constructor}` or `{toString}` must not pick up Object.prototype members.
    if (Object.hasOwn(params, name)) return params[name] as string
    const step = byId.get(name)
    if (step === undefined) return whole
    referencedStep = true
    return renderStep(step)
  })
  const previous = done.at(-1)
  if (referencedStep || previous === undefined) return filled
  return `${filled}\n\nResults of the previous step:\n\n${renderStep(previous)}`
}

/** Instruction for a merging role without its own prompt. */
const DEFAULT_MERGE_PROMPT = 'Merge the results below into one answer: reconcile agreements, call out disagreements, and keep anything only one source found.'

function turnError(result: PoolSendResult): string | undefined {
  if (result.stopReason === 'completed') return undefined
  return `turn ended ${result.stopReason}${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run `template` to its end or to the first fatal step. Never rejects: a
 * cancelled run ends `aborted`, a fatal step `failed`, with the steps done so far.
 * @param pool - role sends (auto-provisioning included).
 * @param template - a validated workspace template.
 * @param params - bound params from {@link bindParams}.
 * @param context - the calling session and its working directory.
 * @param signal - cancels every in-flight send.
 * @param observer - optional progress observer.
 * @param permissionResolver - the caller's confirmation bridge under `permission: ask`, given to every role send (seeding included); absent fails closed.
 */
export async function runWorkflow(
  pool: WorkflowPool,
  template: Template,
  params: Readonly<Record<string, string>>,
  context: RoleCallContext,
  signal: AbortSignal,
  observer: WorkflowObserver = {},
  permissionResolver?: PermissionRequestResolver,
): Promise<WorkflowResult> {
  const send = observedSend(pool, observer, context, signal, permissionResolver)
  const done: StepResult[] = []
  const stop = (status: 'failed' | 'aborted', error: string): WorkflowResult => ({ template: template.name, status, error, steps: done })
  for (const step of template.steps) {
    if (signal.aborted) return stop('aborted', 'the workflow was cancelled')
    contained(() => observer.stepStart?.(step.id))
    const outcome = await runStep(send, step, params, done)
    if (signal.aborted) {
      if (outcome.result !== undefined) done.push(outcome.result)
      return stop('aborted', 'the workflow was cancelled')
    }
    if (outcome.result !== undefined) done.push(outcome.result)
    if (outcome.fatal !== undefined) return stop('failed', `step ${step.id}: ${outcome.fatal}`)
  }
  return { template: template.name, status: 'completed', steps: done }
}

/** One role send in a given step. */
type StepSend = (role: string, stepId: string, prompt: string) => Promise<PoolSendResult>

function contained<T>(call: () => T): T | undefined {
  try { return call() } catch { return undefined }
}

/** Member outcome of a settled (or rejected) send. */
function outcomeOf(result: PoolSendResult | undefined, signal: AbortSignal): MemberOutcome {
  if (signal.aborted || result?.stopReason === 'aborted') return 'cancelled'
  return result?.stopReason === 'completed' ? 'completed' : 'failed'
}

/** Wrap each role send in the observer's member start and end. */
function observedSend(pool: WorkflowPool, observer: WorkflowObserver, context: RoleCallContext, signal: AbortSignal, permissionResolver: PermissionRequestResolver | undefined): StepSend {
  const hooks = permissionResolver === undefined ? {} : { permissionResolver }
  return async (role, stepId, prompt) => {
    const seq = contained(() => observer.memberStart?.(role, stepId))
    let result: PoolSendResult | undefined
    try {
      result = await pool.sendByRole(role, prompt, context, signal, hooks)
      return result
    } finally {
      if (seq !== undefined) contained(() => { observer.memberEnd?.(seq, outcomeOf(result, signal)) })
    }
  }
}

async function runStep(
  send: StepSend,
  step: Step,
  params: Readonly<Record<string, string>>,
  done: readonly StepResult[],
): Promise<{ readonly result?: StepResult; readonly fatal?: string }> {
  if ('merge' in step) {
    if (step.merge.mode === 'return_to_model') return { result: { id: step.id, mode: 'return_to_model' } }
    const context_ = done.map(renderStep).filter(text => text !== '').join('\n\n')
    const prompt = `${fillPrompt(step.merge.prompt ?? DEFAULT_MERGE_PROMPT, params, [])}\n\n${context_}`
    try {
      const sent = await send(step.merge.role, step.id, prompt)
      const error = turnError(sent)
      return error === undefined ? { result: { id: step.id, result: sent.output } } : { fatal: `merge role ${step.merge.role}: ${error}` }
    } catch (error: unknown) {
      return { fatal: `merge role ${step.merge.role}: ${message(error)}` }
    }
  }
  const settled = await Promise.all(step.parallel.map(async (ref): Promise<[string, RoleResult]> => {
    const prompt = fillPrompt(ref.prompt ?? step.prompt ?? '', params, done)
    try {
      const sent = await send(ref.role, step.id, prompt)
      const error = turnError(sent)
      return [ref.role, error === undefined ? sent.output : { error }]
    } catch (error: unknown) {
      return [ref.role, { error: message(error) }]
    }
  }))
  const results = Object.fromEntries(settled)
  const allFailed = settled.every(([, result]) => typeof result !== 'string')
  return { result: { id: step.id, results }, ...(allFailed ? { fatal: 'every role failed' } : {}) }
}
