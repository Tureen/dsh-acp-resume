/**
 * Turn log unit tests (D18): append/read round trip with seq, caps on message
 * and answer text, tolerance of garbage and cut-off lines (and a clean new
 * line after one), seq continuity across instances and trims, the trim to the
 * newest 200 entries, removal, and the never-throw guarantee of a failing
 * write (warned, contained, even from a throwing sink). Keyless; no model.
 *
 * @module dsh-acp-resume/tests/turn-log.spec
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MESSAGE_MAX_CHARS, OUTPUT_MAX_CHARS, RETAINED_ENTRIES, TurnLog, type LogEntryInput } from '../src/turn-log.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(): { dir: string; log: TurnLog; warnings: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'acp-resume-turnlog-'))
  dirs.push(root)
  const dir = join(root, 'turns')
  const warnings: string[] = []
  return { dir, log: new TurnLog(dir, m => warnings.push(m)), warnings }
}

const turn = (message = 'm', over: Partial<Extract<LogEntryInput, { kind: 'turn' }>> = {}): LogEntryInput => ({
  kind: 'turn', startedAt: 1000, at: 2000, message, output: `a:${message}`, stopReason: 'completed', freshSession: false, ...over,
})

describe('TurnLog', () => {
  it('reads nothing for a chat without a log, and creates the directory only on the first append', () => {
    const { dir, log } = setup()
    expect(log.read('chat-a')).toEqual([])
    expect(existsSync(dir)).toBe(false)
    log.append('chat-a', turn())
    expect(existsSync(join(dir, 'chat-a.jsonl'))).toBe(true)
  })

  it('round-trips turns and events oldest first with consecutive seq per chat', () => {
    const { log } = setup()
    log.append('chat-a', turn('one'))
    log.append('chat-a', { kind: 'event', event: 'session-lost', at: 3000, error: 'gone' })
    log.append('chat-a', turn('two', { freshSession: true, diagnostic: 'stage: prompt' }))
    log.append('chat-b', turn('other'))
    expect(log.read('chat-a')).toEqual([
      { v: 1, seq: 1, kind: 'turn', startedAt: 1000, at: 2000, message: 'one', output: 'a:one', stopReason: 'completed', freshSession: false },
      { v: 1, seq: 2, kind: 'event', event: 'session-lost', at: 3000, error: 'gone' },
      { v: 1, seq: 3, kind: 'turn', startedAt: 1000, at: 2000, message: 'two', output: 'a:two', stopReason: 'completed', freshSession: true, diagnostic: 'stage: prompt' },
    ])
    expect(log.read('chat-b').map(e => e.seq)).toEqual([1])
  })

  it('writes one JSON object per line', () => {
    const { dir, log } = setup()
    log.append('chat-a', turn('x\ny'))
    const raw = readFileSync(join(dir, 'chat-a.jsonl'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(raw).message).toBe('x\ny')
  })

  it('caps message and answer text and says so; text within the cap carries no flag', () => {
    const { log } = setup()
    log.append('chat-a', turn('m'.repeat(MESSAGE_MAX_CHARS + 5), { output: 'o'.repeat(OUTPUT_MAX_CHARS + 9) }))
    log.append('chat-a', turn('m'.repeat(MESSAGE_MAX_CHARS), { output: 'o'.repeat(OUTPUT_MAX_CHARS) }))
    const [cut, whole] = log.read('chat-a') as [Extract<ReturnType<TurnLog['read']>[number], { kind: 'turn' }>, Extract<ReturnType<TurnLog['read']>[number], { kind: 'turn' }>]
    expect(cut.message).toHaveLength(MESSAGE_MAX_CHARS)
    expect(cut.output).toHaveLength(OUTPUT_MAX_CHARS)
    expect(cut.messageTruncated).toBe(true)
    expect(cut.outputTruncated).toBe(true)
    expect(whole.message).toHaveLength(MESSAGE_MAX_CHARS)
    expect(whole).not.toHaveProperty('messageTruncated')
    expect(whole).not.toHaveProperty('outputTruncated')
  })

  it('never splits a surrogate pair when it cuts', () => {
    const { log } = setup()
    log.append('chat-a', turn('😀'.repeat(MESSAGE_MAX_CHARS)))
    const [entry] = log.read('chat-a')
    const message = (entry as { message: string }).message
    expect(Array.from(message)).toHaveLength(MESSAGE_MAX_CHARS)
    expect(message.endsWith('😀')).toBe(true)
  })

  it('caps a reconnect-failed event message and its error line', () => {
    const { log } = setup()
    log.append('chat-a', { kind: 'event', event: 'reconnect-failed', at: 1, message: 'm'.repeat(MESSAGE_MAX_CHARS + 1), error: 'e'.repeat(5000) })
    const [entry] = log.read('chat-a') as [{ message: string; messageTruncated?: true; error: string }]
    expect(entry.message).toHaveLength(MESSAGE_MAX_CHARS)
    expect(entry.messageTruncated).toBe(true)
    expect(entry.error).toHaveLength(2000)
  })

  it('skips lines that are not entries and keeps the rest', () => {
    const { dir, log } = setup()
    log.append('chat-a', turn('keep1'))
    appendFileSync(join(dir, 'chat-a.jsonl'), 'not json\n{"v":2,"seq":9,"kind":"turn","at":1}\n[1,2]\n\n{"v":1,"seq":"x","kind":"turn","at":1}\n')
    appendFileSync(join(dir, 'chat-a.jsonl'), `${JSON.stringify({ v: 1, seq: 7, kind: 'event', event: 'session-lost', at: 5 })}\n`)
    expect(log.read('chat-a').map(e => e.seq)).toEqual([1, 7])
  })

  it('survives a cut-off last line: the next append starts a new line and seq continues after the highest readable one', () => {
    const { dir } = setup()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'chat-a.jsonl')
    writeFileSync(file, `${JSON.stringify({ v: 1, seq: 4, kind: 'event', event: 'session-lost', at: 1 })}\n{"v":1,"seq":5,"ki`)
    const log = new TurnLog(dir)
    log.append('chat-a', turn('after the crash'))
    const entries = log.read('chat-a')
    expect(entries.map(e => e.seq)).toEqual([4, 5])
    expect((entries[1] as { message: string }).message).toBe('after the crash')
  })

  it('continues seq across instances over the same directory', () => {
    const { dir, log } = setup()
    log.append('chat-a', turn('1'))
    log.append('chat-a', turn('2'))
    const next = new TurnLog(dir)
    next.append('chat-a', turn('3'))
    expect(next.read('chat-a').map(e => e.seq)).toEqual([1, 2, 3])
  })

  it('trims to the newest 200 entries once past 400, keeping seq monotonic', () => {
    const { dir, log } = setup()
    for (let i = 1; i <= 400; i += 1) log.append('chat-a', turn(`t${i}`))
    expect(log.read('chat-a')).toHaveLength(400)
    log.append('chat-a', turn('t401'))
    const kept = log.read('chat-a')
    expect(kept).toHaveLength(RETAINED_ENTRIES)
    expect(kept[0]?.seq).toBe(202)
    expect(kept.at(-1)?.seq).toBe(401)
    expect(existsSync(join(dir, 'chat-a.jsonl.tmp'))).toBe(false)
    log.append('chat-a', turn('t402'))
    expect(log.read('chat-a').at(-1)?.seq).toBe(402)
    expect(log.read('chat-a')).toHaveLength(RETAINED_ENTRIES + 1)
  })

  it('remove deletes the file, restarts numbering, and tolerates a missing log without a warning', () => {
    const { dir, log, warnings } = setup()
    log.append('chat-a', turn('1'))
    log.append('chat-b', turn('1'))
    log.remove('chat-a')
    expect(existsSync(join(dir, 'chat-a.jsonl'))).toBe(false)
    expect(existsSync(join(dir, 'chat-b.jsonl'))).toBe(true)
    log.remove('chat-a')
    log.remove('chat-never')
    expect(warnings).toEqual([])
    log.append('chat-a', turn('again'))
    expect(log.read('chat-a').map(e => e.seq)).toEqual([1])
  })

  it('warns instead of throwing when a write fails, and a throwing sink does not escape either', () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-resume-turnlog-blocked-'))
    dirs.push(root)
    const blocked = join(root, 'turns')
    writeFileSync(blocked, 'a file where the directory should be')
    const warnings: string[] = []
    const log = new TurnLog(blocked, m => warnings.push(m))
    expect(() => { log.append('chat-a', turn()) }).not.toThrow()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/turn log for chat-a could not be written/)
    const loud = new TurnLog(blocked, () => { throw new Error('sink exploded') })
    expect(() => { loud.append('chat-a', turn()) }).not.toThrow()
  })

  it('refuses an id that could leave the directory, writing nothing', () => {
    const { dir, log, warnings } = setup()
    for (const id of ['../escape', 'a/b', '', '.hidden/..', 'x\0y']) {
      expect(() => { log.append(id, turn()) }).not.toThrow()
      expect(log.read(id)).toEqual([])
    }
    expect(warnings.length).toBeGreaterThanOrEqual(5)
    expect(existsSync(join(dir, '..', 'escape.jsonl'))).toBe(false)
  })

  it('warns and reads empty when the log cannot be read', () => {
    const { dir, log, warnings } = setup()
    mkdirSync(join(dir, 'chat-a.jsonl'), { recursive: true })
    expect(log.read('chat-a')).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/could not be read/)
  })

  it('read caches against the file stamp: an unchanged file returns the SAME array reference (D21)', () => {
    const { log } = setup()
    log.append('chat-a', turn('one'))
    const a = log.read('chat-a')
    const b = log.read('chat-a')
    expect(b).toBe(a)
    expect(a.map(e => (e as { message: string }).message)).toEqual(['one'])
  })

  it('an own append invalidates the cache: the next read returns a new array with the new entry', () => {
    const { log } = setup()
    log.append('chat-a', turn('one'))
    const before = log.read('chat-a')
    log.append('chat-a', turn('two'))
    const after = log.read('chat-a')
    expect(after).not.toBe(before)
    expect(after.map(e => (e as { message: string }).message)).toEqual(['one', 'two'])
  })

  it('a file changed on disk out from under the cache is re-read (stamp mismatch)', () => {
    const { dir, log } = setup()
    log.append('chat-a', turn('one'))
    const before = log.read('chat-a')
    // Append a line directly to the file, bypassing the log: mtime/size move.
    appendFileSync(join(dir, 'chat-a.jsonl'), `${JSON.stringify({ v: 1, seq: 2, kind: 'event', event: 'session-lost', at: 1 })}\n`)
    const after = log.read('chat-a')
    expect(after).not.toBe(before)
    expect(after.map(e => e.seq)).toEqual([1, 2])
  })

  it('remove invalidates the cache: a re-created log is read fresh, not from the stale cache', () => {
    const { log } = setup()
    log.append('chat-a', turn('one'))
    log.read('chat-a')
    log.remove('chat-a')
    expect(log.read('chat-a')).toEqual([])
    log.append('chat-a', turn('again'))
    expect(log.read('chat-a').map(e => (e as { message: string }).message)).toEqual(['again'])
  })
})
