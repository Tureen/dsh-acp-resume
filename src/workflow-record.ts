/**
 * Progress records for `acp_workflow` (D27, 2026-11-20 revision): the four
 * official `tool-workflow/*` session events, written into the calling session
 * so the official `dsh-client-ui-workflow-run` card renders the run with no
 * client code of ours. Field shapes follow the official
 * `tool-workflow/src/types.ts`. Recording never affects the run: the first
 * failed append warns once and disables the rest of this run's records.
 *
 * @module dsh-acp-resume/workflow-record
 */

import { randomUUID } from 'node:crypto'

/** Member settlement, as the official `WorkflowAgentOutcome`. */
export type MemberOutcome = 'completed' | 'failed' | 'cancelled'
/** Run settlement, as the official `WorkflowStopReason`. */
export type RunStopReason = 'completed' | 'error' | 'cancelled'

/** The one session capability the recorder needs; `Session.append` narrowed to these log-only events. */
export interface RecordSink {
  append(type: string, data: unknown): void
}

/** Placeholder child session id of a role member: stable, and no session matches it. */
export function roleChildId(role: string): string {
  return `acp-role:${role}`
}

export class WorkflowRecorder {
  private seq = 0
  private disabled = false

  /**
   * @param session - the calling session; its `append` is used as {@link RecordSink}.
   * @param onWarn - receives one message when an append fails.
   * @param runId - the run id to record under; the D29 tracker passes its own so the panel entry and the card match.
   */
  constructor(private readonly session: unknown, private readonly onWarn?: (message: string) => void, private readonly runId: string = randomUUID()) {}

  /** Open the run record; returns the run id. */
  start(name: string): string {
    this.write('tool-workflow/run-start', { runId: this.runId, name })
    return this.runId
  }

  /** Record a member start; returns its seq (counted even while disabled, so pairs stay aligned). */
  memberStart(label: string, phase: string): number {
    this.seq += 1
    this.write('tool-workflow/agent-start', { runId: this.runId, seq: this.seq, label, phase, childId: roleChildId(label) })
    return this.seq
  }

  memberEnd(seq: number, outcome: MemberOutcome): void {
    this.write('tool-workflow/agent-end', { runId: this.runId, seq, outcome })
  }

  finish(stopReason: RunStopReason): void {
    this.write('tool-workflow/run-end', { runId: this.runId, stopReason })
  }

  private write(type: string, data: unknown): void {
    if (this.disabled) return
    try {
      (this.session as RecordSink).append(type, data)
    } catch (error: unknown) {
      this.disabled = true
      try {
        this.onWarn?.(`acp-resume: workflow progress record disabled after ${type} append failed: ${error instanceof Error ? error.message : String(error)}`)
      } catch { /* a warning sink cannot break the run */ }
    }
  }
}
