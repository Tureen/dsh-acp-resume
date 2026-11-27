/**
 * Steering (`acp_chat_steer`, D19): the private `_session/steer` request is
 * forwarded to a chat's live connection while a turn is in flight. Cases run
 * over a REAL pool and mock-server subprocesses: the happy path reaches the
 * agent without disturbing the turn, an agent without the method degrades to
 * a clear tool error (and leaves the turn alone), and a chat with no turn in
 * flight (completed, released, unknown) is refused. The job-coexistence case
 * lives in jobs.spec. Keyless; no model.
 *
 * @module dsh-acp-resume/tests/steer.spec
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AcpSteerUnsupportedError, type AcpSteerMode } from '../src/connection.ts'
import { agySupportsSteer } from '../src/backend-compatibility.ts'
import { AcpSessionPool } from '../src/pool.ts'
import { registerChatTools, type ToolsRegistryFace } from '../src/tools.ts'
import { nodeSpawn } from './helpers/node-spawn.ts'

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))

const dirs: string[] = []
const pools: AcpSessionPool[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map(p => p.disposeAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Definition = Parameters<ToolsRegistryFace['register']>[0]

/** Five tools over a real pool; no job registry, so send is the inline variant. */
function mountTools(env: Record<string, string>, steerMode?: AcpSteerMode) {
  const tools = new Map<string, Definition>()
  const registry: ToolsRegistryFace = {
    register(definition) {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
  }
  const pool = new AcpSessionPool({
    specBase: {
      command: process.execPath,
      args: [mockServer],
      permission: 'reject',
      env,
      disposeEofGraceMs: 500,
      disposeGraceMs: 500,
      spawn: nodeSpawn,
      ...(steerMode === undefined ? {} : { steerMode }),
    },
    registryPath: join(tempDir('acp-resume-steer-'), 'registry.json'),
    idleTimeoutMs: 600_000,
  })
  pools.push(pool)
  const fakeCtx = { effect: (fn: () => () => void) => { fn() } }
  registerChatTools(fakeCtx as unknown as Context, registry, pool, 'acp_chat_')
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const definition = tools.get(`acp_chat_${name}`)
    if (definition === undefined) throw new Error(`tool acp_chat_${name} not registered`)
    return await definition.execute(args, { signal: new AbortController().signal } as unknown as ToolRunContext) as Record<string, unknown>
  }
  return { tools, pool, call }
}

/** A turn held open by a file: removing the file lets the agent answer. */
function heldTurn(prefix: string): { hold: string; steers: string; release: () => void } {
  const dir = tempDir(prefix)
  const hold = join(dir, 'hold')
  writeFileSync(hold, 'held')
  return { hold, steers: join(dir, 'steers'), release: () => { rmSync(hold, { force: true }) } }
}

describe('acp_chat_steer', () => {
  it('queues a steering message into the in-flight turn and leaves the turn running', async () => {
    const { hold, steers, release } = heldTurn('acp-resume-steer-happy-')
    const { call, tools, pool } = mountTools({ MOCK_TEXT: 'final answer', MOCK_PROMPT_HOLD: hold, MOCK_STEER_FILE: steers })
    expect(tools.get('acp_chat_steer')?.description).toMatch(/next tool or message boundary/)
    expect(tools.get('acp_chat_steer')?.description).toMatch(/job_kill/)
    const { chatId } = await call('start', { cwd: process.cwd() })
    const sending = call('send', { chatId, message: 'long task' })

    const first = await call('steer', { chatId, message: 'prefer small commits' })
    expect(first).toMatchObject({ queued: true, messageId: 'steer-test' })
    expect(first.text).toContain('queued')
    expect(first.text).toContain('steer-test')
    // Several steers on one chat are all delivered, in order.
    await call('steer', { chatId, message: 'and run the linter' })
    const lines = readFileSync(steers, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^steer \S+ prefer small commits$/)
    expect(lines[1]).toMatch(/^steer \S+ and run the linter$/)

    release()
    // Steering neither settled nor disturbed the turn.
    expect(await sending).toEqual({ text: 'final answer' })
    // A steer is not a turn: the turn log holds the one turn and no trace of the steers (D18).
    const logged = pool.turnEntries(chatId as string)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ kind: 'turn', message: 'long task', output: 'final answer', stopReason: 'completed' })
    expect(JSON.stringify(logged)).not.toMatch(/prefer small commits|run the linter/)
  })

  it('fails with a clear degrade message when the agent lacks _session/steer, and the turn is untouched', async () => {
    const { hold, release } = heldTurn('acp-resume-steer-nosupport-')
    const { call, pool } = mountTools({ MOCK_TEXT: 'still fine', MOCK_PROMPT_HOLD: hold, MOCK_NO_STEER: '1' })
    const { chatId } = await call('start', { cwd: process.cwd() })
    const sending = call('send', { chatId, message: 'long task' })

    await expect(call('steer', { chatId, message: 'x' })).rejects.toThrow(/^this backend does not support mid-turn steering; /)
    await expect(pool.steer(chatId as string, 'x')).rejects.toBeInstanceOf(AcpSteerUnsupportedError)

    release()
    expect(await sending).toEqual({ text: 'still fine' })
  })

  it('refuses when no turn is in flight: after a completed turn, after release, and on a fresh chat', async () => {
    const { call, pool } = mountTools({ MOCK_TEXT: 'done' })
    const { chatId } = await call('start', { cwd: process.cwd() })
    // Fresh chat, nothing sent yet.
    await expect(call('steer', { chatId, message: 'x' })).rejects.toThrow(/no turn in flight.*use send instead/)
    expect(await call('send', { chatId, message: 'hi' })).toEqual({ text: 'done' })
    await expect(call('steer', { chatId, message: 'x' })).rejects.toThrow(/no turn in flight/)
    // Released: no live connection at all.
    await pool.close(chatId as string)
    await expect(call('steer', { chatId, message: 'x' })).rejects.toThrow(/no turn in flight/)
  })

  it('names the list tool for an unknown chat, like send and close', async () => {
    const { call } = mountTools({})
    await expect(call('steer', { chatId: 'chat-nope', message: 'x' })).rejects.toThrow('unknown chat chat-nope; call acp_chat_list to see known chats')
  })

  it('does not create a record or a process when steering a chat that was never started', async () => {
    const { hold } = heldTurn('acp-resume-steer-ghost-')
    const marker = join(tempDir('acp-resume-steer-ghost-m-'), 'steers')
    const { pool } = mountTools({ MOCK_PROMPT_HOLD: hold, MOCK_STEER_FILE: marker })
    await expect(pool.steer('chat-ghost', 'x')).rejects.toThrow(/unknown chat/)
    expect(existsSync(marker)).toBe(false)
    expect(pool.listChats()).toEqual([])
  })

  it('steers a running turn through prompt-handoff over a real mock subprocess without early settlement (D51)', async () => {
    const dir = tempDir('acp-resume-steer-handoff-')
    const hold = join(dir, 'hold')
    const ready = join(dir, 'ready')
    const steers = join(dir, 'steers')
    writeFileSync(hold, 'held')
    const { call, pool } = mountTools({
      MOCK_STEER_MODE: 'prompt-handoff',
      MOCK_TEXT: 'before',
      MOCK_FINAL_TEXT: '|after',
      MOCK_PROMPT_HOLD: hold,
      MOCK_READY_FILE: ready,
      MOCK_STEER_FILE: steers,
    }, 'prompt-handoff')
    const { chatId } = await call('start', { cwd: process.cwd() })
    const sending = call('send', { chatId, message: 'long task' })
    const deadline = Date.now() + 5000
    while (!existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
    expect(existsSync(ready)).toBe(true)

    expect(await call('steer', { chatId, message: 'pivot now' })).toMatchObject({ queued: true })
    expect(await call('steer', { chatId, message: 'keep it brief' })).toMatchObject({ queued: true })
    rmSync(hold, { force: true })

    expect(await sending).toEqual({ text: 'before|steered:pivot now|steered:keep it brief|after' })
    expect(pool.turnEntries(chatId as string)).toHaveLength(1)
    expect(readFileSync(steers, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('gates agy prompt-handoff steering on version >= 1.5.0 and refuses unsupported mode without RPC (D51)', async () => {
    expect(agySupportsSteer('1.4.9')).toBe(false)
    expect(agySupportsSteer('1.5.0')).toBe(true)
    expect(agySupportsSteer('1.5.18')).toBe(true)
    const dir = tempDir('acp-resume-steer-gate-')
    const hold = join(dir, 'hold')
    const ready = join(dir, 'ready')
    const steers = join(dir, 'steers')
    writeFileSync(hold, 'held')
    const { call, pool } = mountTools({
      MOCK_STEER_MODE: 'prompt-handoff',
      MOCK_TEXT: 'still fine',
      MOCK_PROMPT_HOLD: hold,
      MOCK_READY_FILE: ready,
      MOCK_STEER_FILE: steers,
    }, 'unsupported')
    const { chatId } = await call('start', { cwd: process.cwd() })
    const sending = call('send', { chatId, message: 'work' })
    const deadline = Date.now() + 5000
    while (!existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
    await expect(call('steer', { chatId, message: 'x' })).rejects.toThrow(/^this backend does not support mid-turn steering; /)
    await expect(pool.steer(chatId as string, 'x')).rejects.toBeInstanceOf(AcpSteerUnsupportedError)
    expect(existsSync(steers)).toBe(false)
    rmSync(hold, { force: true })
    expect(await sending).toEqual({ text: 'still fine' })
  })
})
