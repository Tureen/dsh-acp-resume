/**
 * Connection-primitive lifecycle tests: open (new / load reconnect), one
 * prompt turn with the official settlement semantics, cancellation, and
 * teardown — each against a REAL mock-server subprocess over real ACP stdio.
 * Keyless; no model.
 *
 * @module dsh-acp-resume/tests/connection.spec
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcpContentBlock } from '@agentclientprotocol/sdk'
import { openAcpConnection, type AcpConnection, type AcpRunSpec } from '../src/connection.ts'
import { DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS } from '../src/run.ts'
import { nodeSpawn } from './helpers/node-spawn.ts'

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))

const dirs: string[] = []
const connections: AcpConnection[] = []

function makeSpec(env: Record<string, string> = {}, cwd?: string): { spec: AcpRunSpec; dir: string } {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), 'acp-resume-conn-'))
  dirs.push(dir)
  const spec: AcpRunSpec = {
    command: process.execPath,
    args: [mockServer],
    cwd: dir,
    permission: 'reject',
    env,
    disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
    disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    spawn: nodeSpawn,
  }
  return { spec, dir }
}

function text(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

function ask(message: string): AcpContentBlock[] {
  return [{ type: 'text', text: message }]
}

afterEach(async () => {
  await Promise.allSettled(connections.splice(0).map(c => c.dispose()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('openAcpConnection / AcpConnection', () => {
  it('opens a fresh session, settles one prompt turn, and tears down', async () => {
    const { spec } = makeSpec({ MOCK_TEXT: 'hello from mock' })
    const conn = await openAcpConnection(spec, { mode: 'new' })
    connections.push(conn)
    expect(typeof conn.remoteSessionId).toBe('string')
    const turn = await conn.prompt(ask('p'), new AbortController().signal)
    expect(turn.stopReason).toBe('completed')
    expect(text(turn.output)).toBe('hello from mock')
    expect(turn.diagnostic).toBeUndefined()
    await conn.dispose()
    await expect(conn.dispose()).resolves.toBeUndefined()
  })

  it('maps a remote max_tokens terminal to the harness stop reason', async () => {
    const { spec } = makeSpec({ MOCK_STOP: 'max_tokens' })
    const conn = await openAcpConnection(spec, { mode: 'new' })
    connections.push(conn)
    const turn = await conn.prompt(ask('p'), new AbortController().signal)
    expect(turn.stopReason).toBe('max-tokens')
  })

  it('remembers the previous prompt across turns in the same process (MOCK_REMEMBER)', async () => {
    const { spec } = makeSpec({ MOCK_REMEMBER: '1' })
    const conn = await openAcpConnection(spec, { mode: 'new' })
    connections.push(conn)
    await conn.prompt(ask('记住暗号X'), new AbortController().signal)
    const turn = await conn.prompt(ask('暗号是什么'), new AbortController().signal)
    expect(text(turn.output)).toBe('remember:记住暗号X')
  })

  it('reconnects a persisted session in a NEW process and the context survives (session/load)', async () => {
    const store = join(mkdtempSync(join(tmpdir(), 'acp-resume-store-')), 'sessions.json')
    dirs.push(join(store, '..'))
    const first = makeSpec({ MOCK_SESSION_ID: 'fixed-1', MOCK_REMEMBER: '1', MOCK_SESSION_STORE: store })
    const connA = await openAcpConnection(first.spec, { mode: 'new' })
    await connA.prompt(ask('记住暗号Y'), new AbortController().signal)
    await connA.dispose()

    const second = makeSpec({ MOCK_SESSION_ID: 'fixed-1', MOCK_REMEMBER: '1', MOCK_SESSION_STORE: store }, first.dir)
    const connB = await openAcpConnection(second.spec, { mode: 'load', sessionId: 'fixed-1' })
    connections.push(connB)
    expect(connB.remoteSessionId).toBe('fixed-1')
    const turn = await connB.prompt(ask('暗号是什么'), new AbortController().signal)
    expect(turn.stopReason).toBe('completed')
    expect(text(turn.output)).toBe('remember:记住暗号Y')
  })

  it('rejects a load of an unknown remote session with safe facts', async () => {
    const { spec } = makeSpec({})
    await expect(openAcpConnection(spec, { mode: 'load', sessionId: 'no-such-session' }))
      .rejects.toThrow(/stage: load-session/)
  })

  it('settles an in-flight prompt as aborted on cancellation and still disposes', async () => {
    const { spec } = makeSpec({ MOCK_HANG: '1' })
    const conn = await openAcpConnection(spec, { mode: 'new' })
    connections.push(conn)
    const controller = new AbortController()
    const turnPromise = conn.prompt(ask('p'), controller.signal)
    controller.abort()
    const turn = await turnPromise
    expect(turn.stopReason).toBe('aborted')
    await conn.dispose()
  })
})
