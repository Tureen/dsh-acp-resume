/**
 * Pre-execute gate for D22: refuses `job_output` calls that would block
 * (`wait: true`) on a still-running `acp-chat` job. A chat turn often runs for
 * many minutes, and a blocking wait holds the model's step (and queues the
 * user's new messages) up to the host's wait ceiling; the job's completion
 * notice already wakes the model, so the only collection path left is
 * "notified, then read without wait". Pure decision logic over a minimal job
 * lookup face: no host runtime import beyond types, so it is unit-testable
 * with a real or stub registry. Every doubtful case yields `undefined`
 * (allow) and leaves the verdict to `job_output` itself.
 *
 * @module dsh-acp-resume/job-wait-gate
 */

import type { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

/** The registry face the gate needs: `ctx.jobs` in a host. */
export type JobLookupFace = Pick<JobRegistry, 'get'>

/** The slice of a tool execution the gate reads. */
export type JobWaitExecution = Pick<ToolExecution, 'name' | 'arguments' | 'agent'>

/**
 * Model-facing refusal text for a blocked wait.
 * @param jobId - the running chat job the model tried to wait on.
 */
export function waitDeniedReason(jobId: string): string {
  return `Waiting on job ${jobId} is disabled: it is an acp-chat turn still running, and it already counts as collected, so ending your turn now is correct. `
    + 'Do not poll: reading again before the notification only returns no new output. '
    + 'When it finishes you are woken in-session; then read it with job_output without wait, and you may send to that chat again.'
}

/**
 * Decide whether a tool call must be denied. Denies only a `job_output` call
 * from an agent with `wait: true` and a non-empty `job_id` whose job is of kind
 * `acp-chat` and still `running`. A `stopping` job (the model already
 * killed it) is allowed: a model-requested kill sends no completion notice,
 * and the pool settles a cancelled turn locally at once, so the wait is short.
 * Settled jobs return at once and are allowed; an unknown or foreign job (the lookup throws) is allowed so
 * `job_output` reports its own error.
 * @param jobs - the job registry to look the job up in.
 * @param exec - the pending tool execution.
 * @returns a `deny` decision, or `undefined` to let the next listener decide.
 */
export function decideJobWait(jobs: JobLookupFace, exec: JobWaitExecution): PreToolDecision | undefined {
  if (exec.name !== 'job_output' || exec.agent === undefined) return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const { wait, job_id: jobId } = args as { wait?: unknown; job_id?: unknown }
  if (wait !== true || typeof jobId !== 'string' || jobId === '') return undefined
  let view
  try {
    view = jobs.get(jobId as JobId, exec.agent.id)
  } catch (_unknownOrForeign: unknown) {
    // unknown or foreign job: job_output reports its own error
    return undefined
  }
  if (view.kind !== 'acp-chat') return undefined
  if (view.status !== 'running') return undefined
  return { kind: 'deny', reason: waitDeniedReason(jobId) }
}
