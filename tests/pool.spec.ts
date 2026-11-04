/**
 * Pool lifecycle tests against REAL mock-server subprocesses: same-process
 * turns, reconnect through session/load after release, the D6 fallback rule
 * (only a protocol-level load rejection degrades to a fresh session), idle
 * release, single-flight, connection invalidation after aborted/error turns,
 * cooperative close, teardown across reconnect windows, and registry
 * durability (purge, reconstruction, corrupt-file set-aside). Keyless; no model.
 *
 * @module dsh-acp-resume/tests/pool.spec
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AcpConnectionError } from '../src/connection.ts'
import { AcpSessionPool, type PoolOptions } from '../src/pool.ts'
import { nodeSpawn } from './helpers/node-spawn.ts'

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))

const dirs: string[] = []
const pools: AcpSessionPool[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Every child a pool spawned, in spawn order. */
interface SpawnLog {
  readonly children: SubprocessHandle[]
}

interface PoolSetup {
  env?: Record<string, string>
  idleTimeoutMs?: number
  registryPath?: string
  onWarn?: (message: string) => void
  onError?: (error: Error) => void
}

function makePool(setup: PoolSetup = {}): { pool: AcpSessionPool; registryPath: string; spawns: SpawnLog } {
  const registryPath = setup.registryPath ?? join(tempDir('acp-resume-pool-'), 'registry.json')
  const spawns: SpawnLog = { children: [] }
  const options: PoolOptions = {
    specBase: {
      command: process.execPath,
      args: [mockServer],
      permission: 'reject',
      env: setup.env ?? {},
      // 测试用短宽限:取消后连接作废会同步走一次销毁梯子,默认 6s EOF 窗口会超用例预算
      disposeEofGraceMs: 500,
      disposeGraceMs: 500,
      spawn: (spec: SubprocessSpawnSpec) => {
        const child = nodeSpawn(spec)
        spawns.children.push(child)
        return child
      },
      ...(setup.onError === undefined ? {} : { onError: setup.onError }),
    },
    registryPath,
    idleTimeoutMs: setup.idleTimeoutMs ?? 600_000,
    ...(setup.onWarn === undefined ? {} : { onWarn: setup.onWarn }),
  }
  const pool = new AcpSessionPool(options)
  pools.push(pool)
  return { pool, registryPath, spawns }
}

/** Mock env with a cross-process session store (reconnects run in a new process). */
function storeEnv(prefix: string, extra: Record<string, string> = {}): { env: Record<string, string>; dir: string } {
  const dir = tempDir(prefix)
  return { env: { MOCK_REMEMBER: '1', MOCK_SESSION_STORE: join(dir, 's.json'), ...extra }, dir }
}

function registryRemote(registryPath: string, chatId: string): string | undefined {
  const file = JSON.parse(readFileSync(registryPath, 'utf8')) as { sessions: { chatId: string; remoteSessionId: string }[] }
  return file.sessions.find(s => s.chatId === chatId)?.remoteSessionId
}

interface RegistryRow { chatId: string; remoteSessionId: string; title?: string; turnCount?: number }

function registryRow(registryPath: string, chatId: string): RegistryRow | undefined {
  const file = JSON.parse(readFileSync(registryPath, 'utf8')) as { sessions: RegistryRow[] }
  return file.sessions.find(s => s.chatId === chatId)
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/** Resolve true once every spawned child has exited, false after `timeoutMs`. */
async function allExited(spawns: SpawnLog, timeoutMs = 3000): Promise<boolean> {
  const timeout = new Promise<false>((resolve) => { setTimeout(() => { resolve(false) }, timeoutMs).unref() })
  const exited = Promise.allSettled(spawns.children.map(c => c.done)).then(() => true as const)
  return Promise.race([exited, timeout])
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map(p => p.disposeAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AcpSessionPool', () => {
  it('answers consecutive sends on one live process with surviving context', async () => {
    const { pool, spawns } = makePool({ env: { MOCK_REMEMBER: '1' } })
    const chat = await pool.start(process.cwd())
    const first = await pool.send(chat.chatId, '记住暗号A')
    expect(first.freshSession).toBe(false)
    expect(first.stopReason).toBe('completed')
    const second = await pool.send(chat.chatId, '暗号是什么')
    expect(second.output).toBe('remember:记住暗号A')
    expect(second.freshSession).toBe(false)
    expect(spawns.children).toHaveLength(1)
  })

  it('rejects an invalid idleTimeoutMs at construction', () => {
    for (const idleTimeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 31]) {
      expect(() => makePool({ idleTimeoutMs })).toThrow(/idleTimeoutMs/)
    }
  })

  it('reconnects a released chat through session/load and the context survives', async () => {
    const { env } = storeEnv('acp-resume-store-')
    const { pool, registryPath, spawns } = makePool({ env })
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号B')
    await pool.close(chat.chatId)
    expect(pool.listChats()[0]?.active).toBe(false)
    const again = await pool.send(chat.chatId, '暗号是什么')
    expect(again.freshSession).toBe(false)
    expect(again.output).toBe('remember:记住暗号B')
    expect(again.remoteSessionId).toBe(chat.remoteSessionId)
    expect(registryRemote(registryPath, chat.chatId)).toBe(chat.remoteSessionId)
    expect(spawns.children).toHaveLength(2)
  })

  it('falls back to a fresh session when the remote session is gone, and records the new id', async () => {
    const { env, dir } = storeEnv('acp-resume-store2-')
    const { pool, registryPath } = makePool({ env })
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号G')
    expect(pool.listChats()[0]?.turnCount).toBe(1)
    // 进程释放 + 会话存储被删:load 被远端在协议层拒绝 → 降级新会话
    await pool.close(chat.chatId)
    rmSync(join(dir, 's.json'))
    const after = await pool.send(chat.chatId, '还在吗')
    expect(after.freshSession).toBe(true)
    expect(after.stopReason).toBe('completed')
    expect(after.output).toBe('remember:none')
    expect(after.remoteSessionId).not.toBe(chat.remoteSessionId)
    expect(registryRemote(registryPath, chat.chatId)).toBe(after.remoteSessionId)
    // A completed fallback turn continues the same chat: it counts, and the title stays.
    expect(pool.listChats()[0]).toMatchObject({ turnCount: 2, title: '记住暗号G' })
    // The fresh session is now the chat's session: the next send stays on it.
    const next = await pool.send(chat.chatId, '再问')
    expect(next.freshSession).toBe(false)
    expect(next.output).toBe('remember:还在吗')
    expect(registryRow(registryPath, chat.chatId)).toMatchObject({ turnCount: 3, title: '记住暗号G' })
  })

  it('falls back to a fresh session when session/load is rejected (MOCK_LOAD_MISSING)', async () => {
    const { env, dir } = storeEnv('acp-resume-loadmiss-')
    const loadMissing = join(dir, 'load-missing')
    const { pool, registryPath } = makePool({ env: { ...env, MOCK_LOAD_MISSING_FILE: loadMissing } })
    const chat = await pool.start(process.cwd())
    await pool.close(chat.chatId)
    writeFileSync(loadMissing, 'on')
    const after = await pool.send(chat.chatId, 'p')
    expect(after.freshSession).toBe(true)
    expect(after.remoteSessionId).not.toBe(chat.remoteSessionId)
    expect(registryRemote(registryPath, chat.chatId)).toBe(after.remoteSessionId)
  })

  it('fails the send and keeps the saved session id when the child exits during session/load', async () => {
    const { env, dir } = storeEnv('acp-resume-loadcrash-')
    const crashOnLoad = join(dir, 'crash-on-load')
    const { pool, registryPath } = makePool({ env: { ...env, MOCK_CRASH_ON_LOAD_FILE: crashOnLoad } })
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号H')
    await pool.close(chat.chatId)
    writeFileSync(crashOnLoad, 'on')
    const error = await pool.send(chat.chatId, 'p').then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(AcpConnectionError)
    expect((error as AcpConnectionError).stage).toBe('load-session')
    expect((error as AcpConnectionError).category).not.toBe('protocol')
    expect(registryRemote(registryPath, chat.chatId)).toBe(chat.remoteSessionId)
    expect(pool.listChats()[0]?.active).toBe(false)
    // The failure was transient: once the child behaves, the same session reconnects.
    rmSync(crashOnLoad)
    const after = await pool.send(chat.chatId, '暗号是什么')
    expect(after.freshSession).toBe(false)
    expect(after.output).toBe('remember:记住暗号H')
  })

  it('fails the send and keeps the saved session id when the child exits during initialize', async () => {
    const { env, dir } = storeEnv('acp-resume-initcrash-')
    const crashOnInit = join(dir, 'crash-on-init')
    const { pool, registryPath } = makePool({ env: { ...env, MOCK_CRASH_ON_INITIALIZE_FILE: crashOnInit } })
    const chat = await pool.start(process.cwd())
    await pool.close(chat.chatId)
    writeFileSync(crashOnInit, 'on')
    const error = await pool.send(chat.chatId, 'p').then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(AcpConnectionError)
    expect((error as AcpConnectionError).stage).toBe('initialize')
    expect((error as AcpConnectionError).category).toBe('process-exit')
    expect(registryRemote(registryPath, chat.chatId)).toBe(chat.remoteSessionId)
  })

  it('releases the process after the idle window and reconnects on the next send', async () => {
    const { env } = storeEnv('acp-resume-idle-')
    const { pool } = makePool({ env, idleTimeoutMs: 200 })
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号C')
    await new Promise(r => setTimeout(r, 600))
    expect(pool.listChats().find(c => c.chatId === chat.chatId)?.active).toBe(false)
    const afterIdle = await pool.send(chat.chatId, '暗号是什么')
    expect(afterIdle.freshSession).toBe(false)
    expect(afterIdle.output).toBe('remember:记住暗号C')
  })

  it('does not fire the idle release during a turn longer than the idle window', async () => {
    const dir = tempDir('acp-resume-longturn-')
    const hold = join(dir, 'hold')
    writeFileSync(hold, 'holding')
    const { pool, spawns } = makePool({ env: { MOCK_PROMPT_HOLD: hold }, idleTimeoutMs: 150 })
    const chat = await pool.start(process.cwd())
    const turn = pool.send(chat.chatId, 'slow')
    await new Promise(r => setTimeout(r, 500))
    expect(pool.listChats()[0]?.active).toBe(true)
    rmSync(hold)
    await expect(turn).resolves.toMatchObject({ stopReason: 'completed' })
    expect(spawns.children).toHaveLength(1)
    // The window re-arms after the turn settles.
    await until(() => pool.listChats()[0]?.active === false, 'idle release after the turn')
  })

  it('rejects a second send while one prompt is in flight', async () => {
    const dir = tempDir('acp-resume-busy-')
    const hold = join(dir, 'hold')
    writeFileSync(hold, 'holding')
    const { pool } = makePool({ env: { MOCK_PROMPT_HOLD: hold } })
    const chat = await pool.start(process.cwd())
    const inFlight = pool.send(chat.chatId, 'p1')
    await expect(pool.send(chat.chatId, 'p2')).rejects.toThrow(/in flight/)
    rmSync(hold)
    await expect(inFlight).resolves.toMatchObject({ stopReason: 'completed' })
  })

  it('recovers a chat for further turns after one cancelled turn', async () => {
    const { env, dir } = storeEnv('acp-resume-cancel-')
    const hold = join(dir, 'hold')
    const { pool } = makePool({ env: { ...env, MOCK_PROMPT_HOLD: hold } })
    const chat = await pool.start(process.cwd())
    // 先完成一轮成功对话,确保暗号已落地
    await pool.send(chat.chatId, '记住暗号E')
    expect(pool.listChats()[0]).toMatchObject({ turnCount: 1, title: '记住暗号E' })
    writeFileSync(hold, 'holding')
    // 取消轮发送与成功轮相同的文本:取消轮的消息是否被远端落地是竞速
    // (取消即打断,不承诺副作用),同文本使断言与竞速结果无关。
    const controller = new AbortController()
    const cancelled = pool.send(chat.chatId, '记住暗号E', controller.signal)
    controller.abort()
    await expect(cancelled).resolves.toMatchObject({ stopReason: 'aborted' })
    // The aborted turn neither counts nor touches the title.
    expect(pool.listChats()[0]).toMatchObject({ turnCount: 1, title: '记住暗号E' })
    rmSync(hold)
    const after = await pool.send(chat.chatId, '暗号是什么')
    expect(after.stopReason).toBe('completed')
    expect(after.output).toBe('remember:记住暗号E')
    expect(pool.listChats()[0]).toMatchObject({ turnCount: 2, title: '记住暗号E' })
  }, 15000)

  it('invalidates the connection after a cancelled turn: the next send reconnects in a new process', async () => {
    const { env, dir } = storeEnv('acp-resume-cancel-respawn-')
    const ready = join(dir, 'ready')
    const { pool, spawns } = makePool({ env: { ...env, MOCK_HANG_PROMPTS: '2', MOCK_READY_FILE: ready } })
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号I')
    rmSync(ready)
    const controller = new AbortController()
    const cancelled = pool.send(chat.chatId, 'hang', controller.signal)
    await until(() => existsSync(ready), 'turn 2 in flight')
    controller.abort()
    await expect(cancelled).resolves.toMatchObject({ stopReason: 'aborted' })
    expect(pool.listChats()[0]?.active).toBe(false)
    expect(await allExited(spawns)).toBe(true)
    expect(spawns.children).toHaveLength(1)
    const after = await pool.send(chat.chatId, '暗号是什么')
    expect(spawns.children).toHaveLength(2)
    expect(after.stopReason).toBe('completed')
    expect(after.freshSession).toBe(false)
  })

  it('invalidates the connection after an error turn: the next send reconnects in a new process', async () => {
    const { env } = storeEnv('acp-resume-error-respawn-')
    const { pool, spawns } = makePool({ env: { ...env, MOCK_CRASH_PROMPTS: '2' } })
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号J')
    const failed = await pool.send(chat.chatId, 'crash')
    expect(failed.stopReason).toBe('error')
    expect(failed.diagnostic).toMatch(/process-exit/)
    expect(pool.listChats()[0]?.turnCount).toBe(1)
    expect(pool.listChats()[0]?.active).toBe(false)
    const after = await pool.send(chat.chatId, '暗号是什么')
    expect(spawns.children).toHaveLength(2)
    expect(after.stopReason).toBe('completed')
    // The crashed prompt never reached the session table.
    expect(after.output).toBe('remember:记住暗号J')
  })

  it('reconnects when the live process died between turns', async () => {
    const { env } = storeEnv('acp-resume-dead-')
    const { pool, spawns } = makePool({ env })
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号K')
    const first = spawns.children[0] as SubprocessHandle
    first.terminate()
    await first.done
    const after = await pool.send(chat.chatId, '暗号是什么')
    expect(spawns.children).toHaveLength(2)
    expect(after.stopReason).toBe('completed')
    expect(after.output).toBe('remember:记住暗号K')
  })

  it('rejects a send with an already-aborted signal and keeps the live connection', async () => {
    const { env } = storeEnv('acp-resume-preabort-')
    const { pool, spawns } = makePool({ env })
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号L')
    await expect(pool.send(chat.chatId, 'never sent', AbortSignal.abort())).rejects.toThrow('send aborted before it started')
    expect(pool.listChats()[0]?.active).toBe(true)
    const after = await pool.send(chat.chatId, '暗号是什么')
    expect(after.output).toBe('remember:记住暗号L')
    // The same process answered: the pre-aborted send did not invalidate it.
    expect(spawns.children).toHaveLength(1)
  })

  it('rejects a second send during the reconnect window (no second connection)', async () => {
    const { env, dir } = storeEnv('acp-resume-race-')
    const ready = join(dir, 'load-ready')
    const go = join(dir, 'load-go')
    const { pool, spawns } = makePool({ env: { ...env, MOCK_LOAD_READY: ready, MOCK_LOAD_GO: go } })
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号F')
    await pool.close(chat.chatId)
    // The load gate holds the reconnect open, so the second send provably lands inside the window.
    const first = pool.send(chat.chatId, '第一问')
    await until(() => existsSync(ready), 'reconnect inside session/load')
    await expect(pool.send(chat.chatId, '第二问')).rejects.toThrow(/in flight/)
    writeFileSync(go, 'go')
    const answer = await first
    expect(answer.stopReason).toBe('completed')
    expect(answer.output).toBe('remember:记住暗号F')
    expect(spawns.children).toHaveLength(2)
  })

  it('close cancels an in-flight turn cooperatively and releases the process', async () => {
    const dir = tempDir('acp-resume-close-busy-')
    const ready = join(dir, 'ready')
    const cancels = join(dir, 'cancels')
    const { pool, spawns } = makePool({ env: { MOCK_HANG: '1', MOCK_READY_FILE: ready, MOCK_CANCEL_FILE: cancels } })
    const chat = await pool.start(process.cwd())
    const turn = pool.send(chat.chatId, 'hang')
    await until(() => existsSync(ready), 'turn in flight')
    await pool.close(chat.chatId)
    await expect(turn).resolves.toMatchObject({ stopReason: 'aborted' })
    expect(readFileSync(cancels, 'utf8')).toContain(`cancel ${chat.remoteSessionId}`)
    expect(pool.listChats()[0]?.active).toBe(false)
    expect(await allExited(spawns)).toBe(true)
    expect(pool.knows(chat.chatId)).toBe(true)
  })

  it('close during a reconnect window waits for it, then leaves no live process', async () => {
    const { env, dir } = storeEnv('acp-resume-close-window-')
    const ready = join(dir, 'load-ready')
    const go = join(dir, 'load-go')
    const { pool, spawns } = makePool({ env: { ...env, MOCK_LOAD_READY: ready, MOCK_LOAD_GO: go } })
    const chat = await pool.start(process.cwd())
    await pool.close(chat.chatId)
    const send = pool.send(chat.chatId, 'p').then(r => r.stopReason, (e: unknown) => `rejected: ${(e as Error).message}`)
    await until(() => existsSync(ready), 'reconnect inside session/load')
    const closing = pool.close(chat.chatId)
    writeFileSync(go, 'go')
    await closing
    // Either the turn started and was cancelled by close, or close won and the send was refused.
    expect(await send).toMatch(/^(aborted|completed|rejected: .*released before the prompt started)$/)
    expect(pool.listChats()[0]?.active).toBe(false)
    expect(await allExited(spawns)).toBe(true)
  })

  it('disposeAll during a reconnect window refuses the send and leaves no live process', async () => {
    const { env, dir } = storeEnv('acp-resume-dispose-window-')
    const ready = join(dir, 'load-ready')
    const go = join(dir, 'load-go')
    const { pool, spawns } = makePool({ env: { ...env, MOCK_LOAD_READY: ready, MOCK_LOAD_GO: go } })
    const chat = await pool.start(process.cwd())
    await pool.close(chat.chatId)
    const send = pool.send(chat.chatId, 'p')
    await until(() => existsSync(ready), 'reconnect inside session/load')
    const disposing = pool.disposeAll()
    writeFileSync(go, 'go')
    await disposing
    await expect(send).rejects.toThrow(/disposed/)
    expect(pool.listChats().every(c => !c.active)).toBe(true)
    expect(spawns.children).toHaveLength(2)
    expect(await allExited(spawns)).toBe(true)
    await expect(pool.send(chat.chatId, 'p')).rejects.toThrow(/disposed/)
  })

  it('disposeAll returns within a bounded time when session/load never answers', async () => {
    const { env, dir } = storeEnv('acp-resume-dispose-hung-')
    const ready = join(dir, 'load-ready')
    // GO is never written: the reconnect window stays open until the pool aborts it.
    const { pool, spawns } = makePool({ env: { ...env, MOCK_LOAD_READY: ready, MOCK_LOAD_GO: join(dir, 'load-go') } })
    const chat = await pool.start(process.cwd())
    await pool.close(chat.chatId)
    const send = pool.send(chat.chatId, 'p').then(() => 'resolved', (e: unknown) => (e as Error).message)
    await until(() => existsSync(ready), 'reconnect inside session/load')
    const began = Date.now()
    await pool.disposeAll()
    // disposeGraceMs is 500 in this suite; the window wait is capped by it.
    expect(Date.now() - began).toBeLessThan(1500)
    expect(await send).toMatch(/disposed/)
    expect(pool.listChats().every(c => !c.active)).toBe(true)
    expect(spawns.children).toHaveLength(2)
    expect(await allExited(spawns)).toBe(true)
  })

  it('close returns within a bounded time when session/load never answers, and the chat stays reconnectable', async () => {
    const { env, dir } = storeEnv('acp-resume-close-hung-')
    const ready = join(dir, 'load-ready')
    const go = join(dir, 'load-go')
    const { pool, spawns } = makePool({ env: { ...env, MOCK_LOAD_READY: ready, MOCK_LOAD_GO: go } })
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号M')
    await pool.close(chat.chatId)
    const send = pool.send(chat.chatId, 'p').then(() => 'resolved', (e: unknown) => (e as Error).message)
    await until(() => existsSync(ready), 'reconnect inside session/load')
    const began = Date.now()
    await pool.close(chat.chatId)
    expect(Date.now() - began).toBeLessThan(1500)
    expect(await send).toMatch(/released before the prompt started/)
    expect(await allExited(spawns)).toBe(true)
    expect(pool.listChats()[0]?.active).toBe(false)
    // The aborted window left the record alone: once load answers, the same session continues.
    writeFileSync(go, 'go')
    const after = await pool.send(chat.chatId, '暗号是什么')
    expect(after.freshSession).toBe(false)
    expect(after.output).toBe('remember:记住暗号M')
  })

  it('disposeAll cancels an in-flight turn and releases its process', async () => {
    const dir = tempDir('acp-resume-dispose-busy-')
    const ready = join(dir, 'ready')
    const { pool, spawns } = makePool({ env: { MOCK_HANG: '1', MOCK_READY_FILE: ready } })
    const chat = await pool.start(process.cwd())
    const turn = pool.send(chat.chatId, 'hang')
    await until(() => existsSync(ready), 'turn in flight')
    await pool.disposeAll()
    await expect(turn).resolves.toMatchObject({ stopReason: 'aborted' })
    expect(await allExited(spawns)).toBe(true)
  })

  it('purges the durable record on remove, also on disk', async () => {
    const { pool, registryPath } = makePool({ env: { MOCK_REMEMBER: '1' } })
    const chat = await pool.start(process.cwd())
    const kept = await pool.start(process.cwd())
    expect(pool.knows(chat.chatId)).toBe(true)
    await pool.remove(chat.chatId)
    expect(pool.knows(chat.chatId)).toBe(false)
    expect(pool.listChats().find(c => c.chatId === chat.chatId)).toBeUndefined()
    await expect(pool.send(chat.chatId, 'p')).rejects.toThrow(/unknown chat/)
    await pool.disposeAll()

    const reread = makePool({ registryPath })
    expect(reread.pool.knows(chat.chatId)).toBe(false)
    expect(reread.pool.knows(kept.chatId)).toBe(true)
  })

  it('restores durable chats in a NEW pool instance over the same registry', async () => {
    const { env } = storeEnv('acp-resume-restore-')
    const first = makePool({ env })
    const chat = await first.pool.start(process.cwd())
    await first.pool.send(chat.chatId, '记住暗号D')
    await first.pool.disposeAll()

    const second = makePool({ env, registryPath: first.registryPath })
    const restored = second.pool.listChats().find(c => c.chatId === chat.chatId)
    expect(restored).toBeDefined()
    expect(restored?.active).toBe(false)
    const after = await second.pool.send(chat.chatId, '暗号是什么')
    expect(after.freshSession).toBe(false)
    expect(after.output).toBe('remember:记住暗号D')
  })

  it('persists a chat label and shows it after a pool restart', async () => {
    const first = makePool()
    const labelled = await first.pool.start(process.cwd(), undefined, { label: '  重构评审  ' })
    const plain = await first.pool.start(process.cwd())
    expect(labelled.label).toBe('重构评审')
    expect(first.pool.listChats().find(c => c.chatId === labelled.chatId)?.label).toBe('重构评审')
    expect(first.pool.listChats().find(c => c.chatId === plain.chatId)).not.toHaveProperty('label')
    await first.pool.disposeAll()

    const second = makePool({ registryPath: first.registryPath })
    expect(second.pool.listChats().find(c => c.chatId === labelled.chatId)?.label).toBe('重构评审')
    expect(second.pool.listChats().find(c => c.chatId === plain.chatId)).not.toHaveProperty('label')
  })

  it('counts completed turns and titles the chat with its first message, cut to 40 characters', async () => {
    const { pool, registryPath } = makePool({ env: { MOCK_REMEMBER: '1' } })
    const chat = await pool.start(process.cwd())
    expect(pool.listChats()[0]).not.toHaveProperty('turnCount')
    expect(pool.listChats()[0]).not.toHaveProperty('title')
    // 45 code points after trim, including an astral character at position 40 (must not be split).
    const body = `${'甲'.repeat(39)}😀${'乙'.repeat(5)}`
    await pool.send(chat.chatId, `  ${body}  `)
    await pool.send(chat.chatId, '第二条消息不改标题')
    const expected = `${'甲'.repeat(39)}😀`
    expect(pool.listChats()[0]).toMatchObject({ turnCount: 2, title: expected })
    expect(registryRow(registryPath, chat.chatId)).toMatchObject({ turnCount: 2, title: expected })
  })

  it('leaves the title unset for a whitespace-only first message, and the next completed turn sets it', async () => {
    const { pool } = makePool({ env: { MOCK_REMEMBER: '1' } })
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '   ')
    expect(pool.listChats()[0]?.turnCount).toBe(1)
    expect(pool.listChats()[0]).not.toHaveProperty('title')
    await pool.send(chat.chatId, '真正的问题')
    expect(pool.listChats()[0]).toMatchObject({ turnCount: 2, title: '真正的问题' })
  })

  it('reads a registry entry without title/turnCount and starts counting from its first completed turn', async () => {
    const { env } = storeEnv('acp-resume-legacy-')
    const first = makePool({ env })
    const created = await first.pool.start(process.cwd())
    await first.pool.disposeAll()
    // Hand-written legacy entry (no label/title/turnCount) pointing at the real remote session.
    const { registryPath } = first
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      sessions: [{ chatId: 'chat-legacy', remoteSessionId: created.remoteSessionId, cwd: process.cwd(), command: process.execPath, args: [mockServer], lastActive: 1 }],
    }))
    const warnings: string[] = []
    const second = makePool({ env, registryPath, onWarn: (m) => { warnings.push(m) } })
    expect(second.pool.listChats()).toEqual([{ chatId: 'chat-legacy', remoteSessionId: created.remoteSessionId, cwd: process.cwd(), active: false, lastActive: 1 }])
    const after = await second.pool.send('chat-legacy', '  旧条目的第一轮  ')
    expect(after.stopReason).toBe('completed')
    expect(after.freshSession).toBe(false)
    expect(second.pool.listChats()[0]).toMatchObject({ turnCount: 1, title: '旧条目的第一轮' })
    const row = registryRow(registryPath, 'chat-legacy')
    expect(row).toMatchObject({ remoteSessionId: created.remoteSessionId, turnCount: 1, title: '旧条目的第一轮' })
    expect(warnings).toEqual([])
  })

  it('refuses to reconnect a chat recorded for a different agent command, without spawning', async () => {
    const dir = tempDir('acp-resume-fingerprint-')
    const registryPath = join(dir, 'registry.json')
    // A registry written before labels existed (no label field), by another agent.
    const content = JSON.stringify({
      version: 1,
      sessions: [{ chatId: 'chat-other', remoteSessionId: 'remote-x', cwd: process.cwd(), command: '/opt/other-agent', args: ['acp'], lastActive: 1 }],
    })
    writeFileSync(registryPath, content)
    const { pool, spawns } = makePool({ registryPath })
    expect(pool.listChats()).toEqual([{ chatId: 'chat-other', remoteSessionId: 'remote-x', cwd: process.cwd(), active: false, lastActive: 1 }])
    await expect(pool.send('chat-other', 'p')).rejects.toThrow(/belongs to another agent/)
    expect(spawns.children).toHaveLength(0)
    expect(readFileSync(registryPath, 'utf8')).toBe(content)
  })

  it('refuses to reconnect when only the recorded args differ', async () => {
    const dir = tempDir('acp-resume-fingerprint-args-')
    const registryPath = join(dir, 'registry.json')
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      sessions: [{ chatId: 'chat-args', remoteSessionId: 'remote-y', cwd: process.cwd(), command: process.execPath, args: [mockServer, '--other'], lastActive: 1 }],
    }))
    const { pool, spawns } = makePool({ registryPath })
    await expect(pool.send('chat-args', 'p')).rejects.toThrow(/belongs to another agent/)
    expect(spawns.children).toHaveLength(0)
    expect(registryRemote(registryPath, 'chat-args')).toBe('remote-y')
  })

  it('sets a corrupt registry aside, warns, and starts empty', () => {
    for (const content of ['{not json', JSON.stringify({ version: 2, sessions: [] }), JSON.stringify({ version: 1 })]) {
      const dir = tempDir('acp-resume-corrupt-')
      const registryPath = join(dir, 'registry.json')
      writeFileSync(registryPath, content)
      const warnings: string[] = []
      const { pool } = makePool({ registryPath, onWarn: (m) => { warnings.push(m) } })
      expect(pool.listChats()).toEqual([])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(registryPath)
      expect(existsSync(registryPath)).toBe(false)
      const setAside = readdirSync(dir).filter(name => name.startsWith('registry.json.corrupt-'))
      expect(setAside).toHaveLength(1)
      expect(readFileSync(join(dir, setAside[0] as string), 'utf8')).toBe(content)
    }
  })

  it('treats a missing registry as empty without warning', () => {
    const warnings: string[] = []
    const { pool, registryPath } = makePool({ onWarn: (m) => { warnings.push(m) } })
    expect(existsSync(registryPath)).toBe(false)
    expect(pool.listChats()).toEqual([])
    expect(warnings).toEqual([])
  })
})
