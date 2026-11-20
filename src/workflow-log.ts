/**
 * Per-session workflow run log (D29): `workflows/<ownerSessionId>.jsonl`,
 * two lines per run (`run-start`, `run-end`) with a step/member summary and
 * no answer text and no params. Same discipline as the D18 turn log: append
 * only, trim when the file holds more than {@link TRIM_ABOVE_RUNS} runs (to the
 * newest {@link RETAINED_RUNS}, temporary file + atomic rename), skip bad
 * lines, cache reads by `mtimeMs:size`, and never throw: problems go to
 * `onWarn`. A diagnostic mirror for the panel, never pool state.
 *
 * @module dsh-acp-resume/workflow-log
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemberOutcome } from './workflow-record.js'

/** Runs kept after a trim. */
export const RETAINED_RUNS = 50
/** A file with more runs than this is trimmed. */
export const TRIM_ABOVE_RUNS = 100
/** Finished runs `readRecent` returns by default. */
export const RECENT_RUNS = 5

/** One step of a run as the panel shows it: its members, never their answers. */
export interface WorkflowStepSummary {
  readonly id: string
  readonly members: readonly { readonly role: string; readonly chatId?: string; readonly outcome?: MemberOutcome }[]
}

export type WorkflowRunStatus = 'completed' | 'failed' | 'aborted'

interface RunStartLine {
  readonly v: 1
  readonly kind: 'run-start'
  readonly runId: string
  readonly template: string
  readonly startedAt: number
  readonly jobId?: string
}

interface RunEndLine {
  readonly v: 1
  readonly kind: 'run-end'
  readonly runId: string
  readonly at: number
  readonly status: WorkflowRunStatus
  readonly error?: string
  readonly steps: readonly WorkflowStepSummary[]
}

type Line = RunStartLine | RunEndLine

/** A finished (or interrupted) run, newest first in {@link WorkflowLog.readRecent}. */
export interface WorkflowRunRecord {
  readonly runId: string
  readonly template: string
  readonly startedAt: number
  readonly jobId?: string
  /** Absent for an interrupted run. */
  readonly endedAt?: number
  /** `interrupted`: started, never ended, and not running in this pool instance. */
  readonly status: WorkflowRunStatus | 'interrupted'
  readonly error?: string
  readonly steps: readonly WorkflowStepSummary[]
}

/** Safe file stem: anything that could leave the directory is refused. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isLine(value: unknown): value is Line {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'v') !== 1 || typeof Reflect.get(value, 'runId') !== 'string') return false
  const kind = Reflect.get(value, 'kind')
  if (kind === 'run-start') return typeof Reflect.get(value, 'template') === 'string' && typeof Reflect.get(value, 'startedAt') === 'number'
  return kind === 'run-end' && typeof Reflect.get(value, 'status') === 'string' && Array.isArray(Reflect.get(value, 'steps'))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

export class WorkflowLog {
  private readonly cache = new Map<string, { readonly stamp: string; readonly lines: Line[] }>()

  /**
   * @param dir - directory holding `<ownerSessionId>.jsonl`; created on first append.
   * @param onWarn - receives write/read problems; a throwing sink is contained.
   */
  constructor(private readonly dir: string, private readonly onWarn?: (message: string) => void) {}

  appendRunStart(ownerSessionId: string, runId: string, template: string, startedAt: number, jobId?: string): void {
    this.append(ownerSessionId, { v: 1, kind: 'run-start', runId, template, startedAt, ...(jobId === undefined ? {} : { jobId }) })
  }

  appendRunEnd(ownerSessionId: string, runId: string, at: number, status: WorkflowRunStatus, steps: readonly WorkflowStepSummary[], error?: string): void {
    this.append(ownerSessionId, { v: 1, kind: 'run-end', runId, at, status, steps, ...(error === undefined ? {} : { error }) })
  }

  /**
   * The newest finished runs, newest first. A start without an end counts as
   * `interrupted` unless its runId is in `running` (still going in this pool).
   */
  readRecent(ownerSessionId: string, running: ReadonlySet<string> = new Set(), limit = RECENT_RUNS): readonly WorkflowRunRecord[] {
    const lines = this.read(ownerSessionId)
    const ends = new Map<string, RunEndLine>()
    for (const line of lines) if (line.kind === 'run-end') ends.set(line.runId, line)
    const runs: WorkflowRunRecord[] = []
    for (const line of lines) {
      if (line.kind !== 'run-start' || running.has(line.runId)) continue
      const end = ends.get(line.runId)
      runs.push({
        runId: line.runId,
        template: line.template,
        startedAt: line.startedAt,
        ...(line.jobId === undefined ? {} : { jobId: line.jobId }),
        ...(end === undefined ? {} : { endedAt: end.at }),
        status: end?.status ?? 'interrupted',
        ...(end?.error === undefined ? {} : { error: end.error }),
        steps: end?.steps ?? [],
      })
    }
    return runs.reverse().slice(0, limit)
  }

  /** Delete the session's file; a missing file is fine. */
  remove(ownerSessionId: string): void {
    this.cache.delete(ownerSessionId)
    if (!SAFE_ID.test(ownerSessionId)) return
    try {
      unlinkSync(this.fileFor(ownerSessionId))
    } catch (error: unknown) {
      if (code(error) !== 'ENOENT') this.warn(`acp-resume: workflow log for ${ownerSessionId} could not be deleted: ${message(error)}`)
    }
  }

  private append(ownerSessionId: string, line: Line): void {
    try {
      const file = this.fileFor(ownerSessionId)
      mkdirSync(this.dir, { recursive: true })
      let raw = ''
      try { raw = readFileSync(file, 'utf8') } catch (error: unknown) { if (code(error) !== 'ENOENT') throw error }
      // A line cut off by a crash: start the new record on its own line.
      appendFileSync(file, `${raw !== '' && !raw.endsWith('\n') ? '\n' : ''}${JSON.stringify(line)}\n`)
      this.cache.delete(ownerSessionId)
      if (line.kind === 'run-start') {
        const lines = this.parse(`${raw}\n${JSON.stringify(line)}`)
        if (lines.filter(l => l.kind === 'run-start').length > TRIM_ABOVE_RUNS) this.trim(file, lines)
      }
    } catch (error: unknown) {
      this.warn(`acp-resume: workflow log for ${ownerSessionId} could not be written: ${message(error)}`)
    }
  }

  private read(ownerSessionId: string): Line[] {
    try {
      const file = this.fileFor(ownerSessionId)
      const stat = statSync(file)
      const stamp = `${stat.mtimeMs}:${stat.size}`
      const cached = this.cache.get(ownerSessionId)
      if (cached !== undefined && cached.stamp === stamp) return cached.lines
      const lines = this.parse(readFileSync(file, 'utf8'))
      this.cache.set(ownerSessionId, { stamp, lines })
      return lines
    } catch (error: unknown) {
      if (code(error) !== 'ENOENT' && SAFE_ID.test(ownerSessionId)) this.warn(`acp-resume: workflow log for ${ownerSessionId} could not be read: ${message(error)}`)
      return []
    }
  }

  private parse(raw: string): Line[] {
    const lines: Line[] = []
    for (const text of raw.split('\n')) {
      if (text.trim() === '') continue
      try {
        const value: unknown = JSON.parse(text)
        if (isLine(value)) lines.push(value)
      } catch { /* a bad line is skipped */ }
    }
    return lines
  }

  /** Keep the newest {@link RETAINED_RUNS} runs (their start and end lines). */
  private trim(file: string, lines: readonly Line[]): void {
    const starts = lines.filter(l => l.kind === 'run-start').map(l => l.runId)
    const keep = new Set(starts.slice(-RETAINED_RUNS))
    const kept = lines.filter(l => keep.has(l.runId))
    const tmp = `${file}.tmp`
    writeFileSync(tmp, kept.map(l => `${JSON.stringify(l)}\n`).join(''))
    renameSync(tmp, file)
  }

  private fileFor(ownerSessionId: string): string {
    if (!SAFE_ID.test(ownerSessionId)) throw new Error(`session id ${JSON.stringify(ownerSessionId)} is not a safe file name`)
    return join(this.dir, `${ownerSessionId}.jsonl`)
  }

  private warn(text: string): void {
    try { this.onWarn?.(text) } catch { /* a sink cannot replace the failure */ }
  }
}
