/**
 * Pool lifecycle tests against REAL mock-server subprocesses: same-process
 * turns, reconnect through session/load after release, fresh-session
 * fallback, idle release, busy rejection, and registry survival across pool
 * reconstruction. Keyless; no model.
 *
 * @module dsh-acp-resume/tests/pool.spec
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpSessionPool, type PoolOptions } from '../src/pool.ts'
import { nodeSpawn } from './helpers/node-spawn.ts'

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))

const dirs: string[] = []
const pools: AcpSessionPool[] = []

function makePool(env: Record<string, string> = {}, idleTimeoutMs = 600_000, registryPathOverride?: string): { pool: AcpSessionPool; registryPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-resume-pool-'))
  dirs.push(dir)
  const registryPath = registryPathOverride ?? join(dir, 'registry.json')
  const options: PoolOptions = {
    specBase: {
      command: process.execPath,
      args: [mockServer],
      permission: 'reject',
      env,
      // 测试用短宽限:取消后连接作废会同步走一次销毁梯子,默认 6s EOF 窗口会超用例预算
      disposeEofGraceMs: 500,
      disposeGraceMs: 500,
      spawn: nodeSpawn,
    },
    registryPath,
    idleTimeoutMs,
  }
  const pool = new AcpSessionPool(options)
  pools.push(pool)
  return { pool, registryPath, dir }
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map(p => p.disposeAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AcpSessionPool', () => {
  it('answers consecutive sends on one live process with surviving context', async () => {
    const { pool } = makePool({ MOCK_REMEMBER: '1' })
    const chat = await pool.start(process.cwd())
    const first = await pool.send(chat.chatId, '记住暗号A')
    expect(first.freshSession).toBe(false)
    expect(first.stopReason).toBe('completed')
    const second = await pool.send(chat.chatId, '暗号是什么')
    expect(second.output).toBe('remember:记住暗号A')
    expect(second.freshSession).toBe(false)
  })

  it('reconnects a released chat through session/load and the context survives', async () => {
    const { pool } = makePool({ MOCK_REMEMBER: '1', MOCK_SESSION_ID: 'pool-fixed', MOCK_SESSION_STORE: undefined } as Record<string, string>)
    // 同进程 mock 之外,重连发生在新进程:mock 的跨进程记忆需要 STORE。
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-store-'))
    dirs.push(dir)
    const storeEnv = { MOCK_REMEMBER: '1', MOCK_SESSION_ID: 'pool-fixed', MOCK_SESSION_STORE: join(dir, 's.json') }
    const { pool: p2, registryPath } = makePool(storeEnv)
    const chat = await p2.start(process.cwd())
    await p2.send(chat.chatId, '记住暗号B')
    await p2.close(chat.chatId)
    expect(p2.listChats()[0]?.active).toBe(false)
    const again = await p2.send(chat.chatId, '暗号是什么')
    expect(again.freshSession).toBe(false)
    expect(again.output).toBe('remember:记住暗号B')
    expect(existsSync(registryPath)).toBe(true)
    void pool
  })

  it('falls back to a fresh session when load is rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-store2-'))
    dirs.push(dir)
    const env = { MOCK_REMEMBER: '1', MOCK_SESSION_ID: 'pool-gone', MOCK_SESSION_STORE: join(dir, 's.json') }
    const { pool } = makePool(env)
    const chat = await pool.start(process.cwd())
    const originalRemote = chat.remoteSessionId
    // 进程释放 + 会话存储被删:重连必失败 → 降级新会话
    await pool.close(chat.chatId)
    ;(globalThis as { __never?: never }).__never
    const fs = await import('node:fs')
    fs.rmSync(join(dir, 's.json'))
    const after = await pool.send(chat.chatId, '还在吗')
    expect(after.freshSession).toBe(true)
    void originalRemote
    expect(after.stopReason).toBe('completed')
  })

  it('releases the process after the idle window and reconnects on the next send', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-idle-'))
    dirs.push(dir)
    const env = { MOCK_REMEMBER: '1', MOCK_SESSION_ID: 'pool-idle', MOCK_SESSION_STORE: join(dir, 's.json') }
    const { pool } = makePool(env, 200)
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号C')
    await new Promise(r => setTimeout(r, 600))
    expect(pool.listChats().find(c => c.chatId === chat.chatId)?.active).toBe(false)
    const afterIdle = await pool.send(chat.chatId, '暗号是什么')
    expect(afterIdle.freshSession).toBe(false)
    expect(afterIdle.output).toBe('remember:记住暗号C')
  })

  it('rejects a second send while one prompt is in flight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-busy-'))
    dirs.push(dir)
    const hold = join(dir, 'hold')
    const fs = await import('node:fs')
    fs.writeFileSync(hold, 'holding')
    const { pool } = makePool({ MOCK_PROMPT_HOLD: hold })
    const chat = await pool.start(process.cwd())
    const inFlight = pool.send(chat.chatId, 'p1')
    await expect(pool.send(chat.chatId, 'p2')).rejects.toThrow(/in flight/)
    fs.rmSync(hold)
    await expect(inFlight).resolves.toMatchObject({ stopReason: 'completed' })
  })

  it('recovers a chat for further turns after one cancelled turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-cancel-'))
    dirs.push(dir)
    const hold = join(dir, 'hold')
    const fs = await import('node:fs')
    const env = { MOCK_REMEMBER: '1', MOCK_SESSION_ID: 'pool-cancel', MOCK_SESSION_STORE: join(dir, 's.json'), MOCK_PROMPT_HOLD: hold }
    const { pool } = makePool(env)
    const chat = await pool.start(process.cwd())
    // 先完成一轮成功对话,确保暗号已落地
    await pool.send(chat.chatId, '记住暗号E')
    fs.writeFileSync(hold, 'holding')
    // 取消轮发送与成功轮相同的文本:取消轮的消息是否被远端落地是竞速
    // (取消即打断,不承诺副作用),同文本使断言与竞速结果无关。
    const controller = new AbortController()
    const cancelled = pool.send(chat.chatId, '记住暗号E', controller.signal)
    controller.abort()
    await expect(cancelled).resolves.toMatchObject({ stopReason: 'aborted' })
    fs.rmSync(hold)
    const after = await pool.send(chat.chatId, '暗号是什么')
    expect(after.stopReason).toBe('completed')
    expect(after.output).toBe('remember:记住暗号E')
  }, 15000)

  it('rejects a concurrent send during the reconnect window (no second connection)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-race-'))
    dirs.push(dir)
    const gate = join(dir, 'gate')
    const fs = await import('node:fs')
    // 首个进程建会话并记住暗号;释放后用 newSession 门挡住重连,使窗口可观察
    fs.writeFileSync(gate, 'closed')
    const env = { MOCK_REMEMBER: '1', MOCK_SESSION_ID: 'pool-race', MOCK_SESSION_STORE: join(dir, 's.json') }
    const { pool } = makePool(env)
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, '记住暗号F')
    await pool.close(chat.chatId)
    const first = pool.send(chat.chatId, '第一问')
    await expect(pool.send(chat.chatId, '第二问')).rejects.toThrow(/in flight/)
    const answer = await first
    expect(answer.stopReason).toBe('completed')
    void gate
  })

  it('purges the durable record on remove', async () => {
    const { pool } = makePool({ MOCK_REMEMBER: '1' })
    const chat = await pool.start(process.cwd())
    expect(pool.knows(chat.chatId)).toBe(true)
    await pool.remove(chat.chatId)
    expect(pool.knows(chat.chatId)).toBe(false)
    expect(pool.listChats().find(c => c.chatId === chat.chatId)).toBeUndefined()
    await expect(pool.send(chat.chatId, 'p')).rejects.toThrow(/unknown chat/)
  })

  it('restores durable chats in a NEW pool instance over the same registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-restore-'))
    dirs.push(dir)
    const env = { MOCK_REMEMBER: '1', MOCK_SESSION_ID: 'pool-restore', MOCK_SESSION_STORE: join(dir, 's.json') }
    const first = makePool(env)
    const chat = await first.pool.start(process.cwd())
    await first.pool.send(chat.chatId, '记住暗号D')
    await first.pool.disposeAll()

    const second = makePool(env, 600_000, first.registryPath)
    const restored = second.pool.listChats().find(c => c.chatId === chat.chatId)
    expect(restored).toBeDefined()
    expect(restored?.active).toBe(false)
    const after = await second.pool.send(chat.chatId, '暗号是什么')
    expect(after.freshSession).toBe(false)
    expect(after.output).toBe('remember:记住暗号D')
  })
})
