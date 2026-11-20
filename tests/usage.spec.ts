/**
 * D28 backend usage: the reply mapping, the cache (cold wait, expired
 * stale-while-refresh, forced refresh, single flight, failures), Codex reads
 * over a live pooled connection and over a temporary usage-mode app-server
 * against the real mock-codex-server, the read-only allowlist, the
 * `acp_backend_usage` tool, and the `acpResume/usage` Remote method. Keyless; no model.
 *
 * @module dsh-acp-resume/tests/usage.spec
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { AcpConnection } from '../src/connection.ts'
import { AcpResumePanelService } from '../src/panel.ts'
import { AcpSessionPool, type BackendSpec } from '../src/pool.ts'
import { chatUsageTool } from '../src/tools.ts'
import { toBackendUsage, USAGE_ERROR_TTL_MS, USAGE_TTL_MS, UsageService, type UsagePool } from '../src/usage.ts'
import { nodeSpawn } from './helpers/node-spawn.ts'

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))
const codexMock = fileURLToPath(new URL('./mock-codex-server.ts', import.meta.url))

const dirs: string[] = []
const pools: AcpSessionPool[] = []

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map(p => p.disposeAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const ACCOUNT = { account: { type: 'chatgpt', email: null, planType: 'prolite', workspaceName: null }, userId: null, requiresOpenaiAuth: false }
const LIMITS = (primary: number, secondary: number) => ({
  rateLimits: {
    primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: 1_800_000_300 },
    secondary: { usedPercent: secondary, windowDurationMins: 10080, resetsAt: 1_800_600_000 },
    planType: 'plus',
  },
})

describe('toBackendUsage (D28)', () => {
  it('reports the plan and the most-used window, uncapped', () => {
    expect(toBackendUsage('codex', ACCOUNT, LIMITS(12, 83), 5)).toEqual({ backend: 'codex', protocol: 'codex', status: 'ok', plan: 'prolite', usedPercent: 83, windowMins: 10080, resetsAt: 1_800_600_000, fetchedAt: 5 })
    expect(toBackendUsage('codex', ACCOUNT, LIMITS(120, 40), 5)).toMatchObject({ usedPercent: 120, windowMins: 300, resetsAt: 1_800_000_300 })
    // Tie: the longer window.
    expect(toBackendUsage('codex', ACCOUNT, LIMITS(50, 50), 5)).toMatchObject({ windowMins: 10080 })
  })

  it('falls back to the account type, then the snapshot plan, and tolerates missing windows', () => {
    expect(toBackendUsage('c', { account: { type: 'apiKey' } }, { rateLimits: { primary: null, secondary: null } }, 1)).toEqual({ backend: 'c', protocol: 'codex', status: 'ok', plan: 'apiKey', fetchedAt: 1 })
    expect(toBackendUsage('c', { account: null }, LIMITS(1, 2), 1)).toMatchObject({ plan: 'plus', usedPercent: 2 })
    expect(toBackendUsage('c', 'garbage', null, 1)).toEqual({ backend: 'c', protocol: 'codex', status: 'ok', fetchedAt: 1 })
  })
})

describe('UsageService cache (D28)', () => {
  /** A fake pool whose Codex reads count and can be held or failed. */
  function fakePool(backends = [{ name: 'default', protocol: 'acp' as const }, { name: 'codex', protocol: 'codex' as const }]) {
    const state = { reads: 0, percent: 10, fail: false, hold: undefined as Promise<void> | undefined }
    const pool: UsagePool = {
      backendList: () => backends,
      async withCodexUsage(_backend, read) {
        state.reads += 1
        const conn = {
          readAccount: async () => ACCOUNT,
          readRateLimits: async () => {
            await state.hold
            if (state.fail) throw new Error('usage backend unavailable')
            return LIMITS(1, state.percent)
          },
        } as unknown as AcpConnection
        return read(conn)
      },
    }
    return { pool, state }
  }

  it('waits on a cold cache, serves a hit, returns stale data at once while one background read refreshes it, and forces with refresh', async () => {
    let now = 1_000
    const { pool, state } = fakePool()
    const usage = new UsageService(pool, () => now)
    const [acp, first] = await usage.read()
    expect(acp).toEqual({ backend: 'default', protocol: 'acp', status: 'unsupported', fetchedAt: 1_000 })
    expect(first).toMatchObject({ backend: 'codex', status: 'ok', usedPercent: 10, fetchedAt: 1_000 })
    state.percent = 20
    now += USAGE_TTL_MS - 1
    expect((await usage.read({ backend: 'codex' }))[0]).toMatchObject({ usedPercent: 10 })
    expect(state.reads).toBe(1)
    // Expired: the old value comes back at once, a single background read replaces it.
    now += 1
    expect((await usage.read({ backend: 'codex' }))[0]).toMatchObject({ usedPercent: 10 })
    expect((await usage.read({ backend: 'codex' }))[0]).toMatchObject({ usedPercent: 10 })
    await new Promise(r => setTimeout(r, 0))
    expect(state.reads).toBe(2)
    expect((await usage.read({ backend: 'codex' }))[0]).toMatchObject({ usedPercent: 20 })
    state.percent = 30
    expect((await usage.read({ backend: 'codex', refresh: true }))[0]).toMatchObject({ usedPercent: 30 })
    expect(state.reads).toBe(3)
  })

  it('shares one read among concurrent callers, caches failures for a shorter time, and rejects an unknown backend', async () => {
    let now = 0
    const { pool, state } = fakePool()
    let release!: () => void
    state.hold = new Promise((resolve) => { release = resolve })
    const usage = new UsageService(pool, () => now)
    const a = usage.read({ backend: 'codex' })
    const b = usage.read({ backend: 'codex', refresh: true })
    release()
    expect((await a)[0]).toEqual((await b)[0])
    expect(state.reads).toBe(1)
    state.hold = undefined
    state.fail = true
    const failed = (await usage.read({ backend: 'codex', refresh: true }))[0]
    expect(failed).toMatchObject({ status: 'error', error: 'usage backend unavailable' })
    now += USAGE_ERROR_TTL_MS
    state.fail = false
    await usage.read({ backend: 'codex' })
    await new Promise(r => setTimeout(r, 0))
    expect((await usage.read({ backend: 'codex' }))[0]).toMatchObject({ status: 'ok' })
    await expect(usage.read({ backend: 'nope' })).rejects.toThrow('unknown backend nope; configured backends: default, codex')
  })

  it('times a hung read out as an error', async () => {
    const pool: UsagePool = { backendList: () => [{ name: 'codex', protocol: 'codex' }], withCodexUsage: () => new Promise(() => {}) }
    expect((await new UsageService(pool, Date.now, 20).read())[0]).toMatchObject({ status: 'error', error: 'usage read timed out after 20 ms' })
  })
})

describe('Codex usage reads over the pool (D28)', () => {
  function codexPool(env: Record<string, string> = {}) {
    const dir = tempDir('acp-resume-usage-')
    const requests = join(dir, 'requests')
    const spawned: SubprocessHandle[] = []
    const codex: BackendSpec = {
      name: 'codex', description: 'Codex', protocol: 'codex', codex: { model: 'mock-model' },
      specBase: {
        command: process.execPath, args: [codexMock], permission: 'reject', env: { MOCK_REQUEST_FILE: requests, MOCK_SESSION_STORE: join(dir, 's.json'), ...env },
        disposeEofGraceMs: 500, disposeGraceMs: 500,
        spawn: (spec: SubprocessSpawnSpec) => { const child = nodeSpawn(spec); spawned.push(child); return child },
      },
    }
    const pool = new AcpSessionPool({
      specBase: { command: process.execPath, args: [mockServer], permission: 'reject', env: {}, disposeEofGraceMs: 500, disposeGraceMs: 500, spawn: nodeSpawn },
      backends: new Map([['codex', codex]]),
      registryPath: join(dir, 'registry.json'),
      idleTimeoutMs: 600_000,
    })
    pools.push(pool)
    const lines = (): string[] => existsSync(requests) ? readFileSync(requests, 'utf8').split('\n').filter(l => l !== '') : []
    return { pool, spawned, lines }
  }

  it('opens a temporary usage-mode app-server without a live chat: initialize and the two read-only methods only, then closes it', async () => {
    const { pool, spawned, lines } = codexPool()
    const [, codex] = await new UsageService(pool).read()
    expect(codex).toMatchObject({ backend: 'codex', protocol: 'codex', status: 'ok', plan: 'prolite', usedPercent: 83, windowMins: 10080, resetsAt: 1_800_600_000 })
    expect(spawned).toHaveLength(1)
    await spawned[0]?.done.catch(() => undefined)
    // No thread was opened; the rate-limit read asked to skip reset-credit details.
    expect(lines()).toEqual(['account/read {}', 'account/rateLimits/read {"excludeResetCreditDetails":true}'])
    expect(pool.listChats()).toEqual([])
  })

  it('borrows a live Codex chat connection instead of spawning, and reports a failed read as error', async () => {
    const { pool, spawned, lines } = codexPool()
    await pool.start(process.cwd(), undefined, { backend: 'codex' })
    expect(spawned).toHaveLength(1)
    const [, codex] = await new UsageService(pool).read({ refresh: true })
    expect(codex).toMatchObject({ status: 'ok', usedPercent: 83 })
    expect(spawned).toHaveLength(1)
    expect(lines().filter(l => l.startsWith('account/'))).toHaveLength(2)
    const failing = codexPool({ MOCK_CODEX_RATE_LIMITS_FAIL: '1' })
    expect((await new UsageService(failing.pool).read({ backend: 'codex' }))[0]).toMatchObject({ status: 'error', error: 'usage backend unavailable' })
  })

  it('serves the tool and the panel Remote method from the same service', async () => {
    const { pool } = codexPool()
    const usage = new UsageService(pool)
    const tool = chatUsageTool(usage)
    const { text } = await tool.execute({ backend: 'codex' }, { signal: new AbortController().signal } as unknown as ToolRunContext) as { text: string }
    expect(JSON.parse(text)).toEqual([expect.objectContaining({ backend: 'codex', status: 'ok', plan: 'prolite', usedPercent: 83 })])
    await expect(tool.execute({ backend: 'nope' }, { signal: new AbortController().signal } as unknown as ToolRunContext)).rejects.toThrow(/unknown backend nope/)
    const panel = new AcpResumePanelService(new Context(), pool, usage)
    expect((await panel.usage(undefined as unknown as boolean)).map(u => [u.backend, u.status])).toEqual([['default', 'unsupported'], ['codex', 'ok']])
    await expect(panel.usage('yes' as unknown as boolean)).rejects.toThrow('refresh must be a boolean')
    expect(await new AcpResumePanelService(new Context(), pool).usage(false)).toEqual([])
  })
})
