/**
 * Per-chat turn log (D18): an append-only JSONL file `<dir>/<chatId>.jsonl`
 * holding what the side panel's detail page shows. One line per settled turn
 * (message, answer text, stop reason, timestamps, fresh-session flag) and one
 * per reconnect event (`session-lost`, `reconnect-failed`). Steers are not
 * turns and are never logged. The log is a diagnostic mirror, not state: a
 * write that fails is reported through `onWarn` and never throws, so it can
 * never change a turn's outcome; the registry stays the source of truth for
 * the chat itself. Text fields are capped per record, the file is trimmed to
 * the newest {@link RETAINED_ENTRIES} entries once it grows past twice that,
 * and reads skip lines that do not parse (a crash can leave a partial last
 * line). Single writer: the owning pool.
 *
 * @module dsh-acp-resume/turn-log
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Entries kept after a trim; reads never return more than the file holds. */
export const RETAINED_ENTRIES = 200
/** The file is trimmed when it holds more than this many entries. */
const TRIM_ABOVE = RETAINED_ENTRIES * 2
/** Cap on a logged message, in characters. */
export const MESSAGE_MAX_CHARS = 8192
/** Cap on a logged answer, in characters. */
export const OUTPUT_MAX_CHARS = 32768
/** Cap on a logged diagnostic or error line, in characters. */
const NOTE_MAX_CHARS = 2000

/** One settled turn (any stop reason). */
export interface TurnRecord {
  readonly v: 1
  /** Position in this chat's log, from 1; not reused after a trim. */
  readonly seq: number
  readonly kind: 'turn'
  /** Epoch ms the prompt went out. */
  readonly startedAt: number
  /** Epoch ms the turn settled. */
  readonly at: number
  readonly message: string
  readonly output: string
  readonly stopReason: string
  /** The remote session was lost and a fresh one answered. */
  readonly freshSession: boolean
  readonly diagnostic?: string
  readonly messageTruncated?: true
  readonly outputTruncated?: true
}

/** A reconnect that did not go the plain way. */
export interface EventRecord {
  readonly v: 1
  readonly seq: number
  readonly kind: 'event'
  /** `session-lost`: `session/load` was rejected and a fresh session replaced it; `reconnect-failed`: the send failed before its prompt went out. */
  readonly event: 'session-lost' | 'reconnect-failed'
  readonly at: number
  /** The message the failed send carried (`reconnect-failed` only). */
  readonly message?: string
  readonly error?: string
  readonly messageTruncated?: true
}

/** A log line. */
export type LogEntry = TurnRecord | EventRecord

type Input<T> = T extends unknown ? Omit<T, 'v' | 'seq'> : never

/** What a caller supplies; the log adds `v` and `seq`. */
export type LogEntryInput = Input<LogEntry>

function cap(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  // Code points, so a surrogate pair is never split.
  return { text: Array.from(text).slice(0, max).join(''), truncated: true }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isEntry(value: unknown): value is LogEntry {
  if (typeof value !== 'object' || value === null) return false
  const kind = Reflect.get(value, 'kind')
  return Reflect.get(value, 'v') === 1
    && typeof Reflect.get(value, 'seq') === 'number'
    && typeof Reflect.get(value, 'at') === 'number'
    && (kind === 'turn' || kind === 'event')
}

/** Safe file stem: minted ids are `chat-<uuid>`; anything that could leave the directory is refused. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

interface Counter {
  next: number
  count: number
  /** The file's last line was cut off by a crash: the next append starts a new line first. */
  needsNewline: boolean
}

/** The per-chat logs of one pool, under one directory. */
export class TurnLog {
  private readonly counters = new Map<string, Counter>()

  /**
   * @param dir - directory holding `<chatId>.jsonl`; created on first append.
   * @param onWarn - receives write/read problems; a throwing sink is contained.
   */
  constructor(private readonly dir: string, private readonly onWarn?: (message: string) => void) {}

  /** Append one entry. Never throws. */
  append(chatId: string, input: LogEntryInput): void {
    try {
      const file = this.fileFor(chatId)
      const counter = this.counterFor(chatId, file)
      const record = this.shape(counter.next, input)
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(file, `${counter.needsNewline ? '\n' : ''}${JSON.stringify(record)}\n`)
      counter.needsNewline = false
      counter.next += 1
      counter.count += 1
      if (counter.count > TRIM_ABOVE) this.trim(file, counter)
    } catch (error: unknown) {
      this.warn(`acp-resume: turn log for ${chatId} could not be written: ${toError(error).message}`)
    }
  }

  /** Every retained entry, oldest first; unparsable lines are skipped; an unreadable file reads as empty. */
  read(chatId: string): LogEntry[] {
    let raw: string
    try {
      raw = readFileSync(this.fileFor(chatId), 'utf8')
    } catch (error: unknown) {
      if (Reflect.get(toError(error), 'code') !== 'ENOENT') {
        this.warn(`acp-resume: turn log for ${chatId} could not be read: ${toError(error).message}`)
      }
      return []
    }
    return this.parse(raw).entries
  }

  /** Delete the chat's log; a missing file is fine, any other failure is a warning. */
  remove(chatId: string): void {
    this.counters.delete(chatId)
    try {
      unlinkSync(this.fileFor(chatId))
    } catch (error: unknown) {
      if (Reflect.get(toError(error), 'code') !== 'ENOENT') {
        this.warn(`acp-resume: turn log for ${chatId} could not be deleted: ${toError(error).message}`)
      }
    }
  }

  private fileFor(chatId: string): string {
    if (!SAFE_ID.test(chatId)) throw new Error(`chat id ${JSON.stringify(chatId)} is not a safe file name`)
    return join(this.dir, `${chatId}.jsonl`)
  }

  private shape(seq: number, input: LogEntryInput): LogEntry {
    if (input.kind === 'event') {
      const message = input.message === undefined ? undefined : cap(input.message, MESSAGE_MAX_CHARS)
      const error = input.error === undefined ? undefined : cap(input.error, NOTE_MAX_CHARS).text
      return {
        v: 1, seq, kind: 'event', event: input.event, at: input.at,
        ...(message === undefined ? {} : { message: message.text }),
        ...(message?.truncated === true ? { messageTruncated: true as const } : {}),
        ...(error === undefined ? {} : { error }),
      }
    }
    const message = cap(input.message, MESSAGE_MAX_CHARS)
    const output = cap(input.output, OUTPUT_MAX_CHARS)
    const diagnostic = input.diagnostic === undefined ? undefined : cap(input.diagnostic, NOTE_MAX_CHARS).text
    return {
      v: 1, seq, kind: 'turn', startedAt: input.startedAt, at: input.at,
      message: message.text, output: output.text, stopReason: input.stopReason, freshSession: input.freshSession,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(message.truncated ? { messageTruncated: true as const } : {}),
      ...(output.truncated ? { outputTruncated: true as const } : {}),
    }
  }

  /** The chat's next seq and entry count, loaded from the file once per process. */
  private counterFor(chatId: string, file: string): Counter {
    const known = this.counters.get(chatId)
    if (known !== undefined) return known
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error: unknown) {
      if (Reflect.get(toError(error), 'code') !== 'ENOENT') throw error
    }
    const { entries } = this.parse(raw)
    const counter: Counter = {
      next: entries.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1,
      count: entries.length,
      needsNewline: raw !== '' && !raw.endsWith('\n'),
    }
    this.counters.set(chatId, counter)
    return counter
  }

  private parse(raw: string): { entries: LogEntry[]; skipped: number } {
    const entries: LogEntry[] = []
    let skipped = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const value: unknown = JSON.parse(line)
        if (isEntry(value)) entries.push(value)
        else skipped += 1
      } catch {
        skipped += 1
      }
    }
    return { entries, skipped }
  }

  /** Rewrite the file with the newest entries (temporary file + atomic rename). */
  private trim(file: string, counter: Counter): void {
    const kept = this.parse(readFileSync(file, 'utf8')).entries.slice(-RETAINED_ENTRIES)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, kept.map(entry => `${JSON.stringify(entry)}\n`).join(''))
    renameSync(tmp, file)
    counter.count = kept.length
  }

  private warn(message: string): void {
    try { this.onWarn?.(message) } catch { /* a sink cannot replace the failure */ }
  }
}
