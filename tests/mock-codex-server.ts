/**
 * A minimal mock Codex `app-server`, run as a subprocess, for the D25 tests.
 * It speaks the agent side of Codex's private JSON-RPC protocol (newline-delimited
 * over stdio; no ACP SDK) and is scripted by environment variables, no model, no network.
 * Methods: `initialize`, `thread/start`, `thread/resume`, `turn/start`, `turn/steer`,
 * `turn/interrupt`, `model/list`. Notification order per turn: `turn/started`,
 * `item/started` (userMessage), [approval request], `item/agentMessage/delta`
 * (two chunks), `item/completed` (agentMessage, phase `final_answer`), `turn/completed`.
 *
 * - `MOCK_TEXT`          — the answer text (default `mock codex answer`), streamed as two deltas.
 * - `MOCK_REMEMBER`      — if `1`, the answer is `remember:<previous prompt of this thread>` (or `remember:none`).
 * - `MOCK_SESSION_STORE` — file persisting the thread table, so a second process can `thread/resume`.
 *                          Written only for threads started with `ephemeral:false`.
 * - `MOCK_LOAD_MISSING`  — if `1`, `thread/resume` always fails (unknown thread), for the fresh-session fallback.
 * - `MOCK_CODEX_DELAY_MS` — wait this long after `item/started` before answering (cut short by an interrupt).
 * - `MOCK_HANG`          — if `1`, never answer on its own; only `turn/interrupt` ends the turn.
 * - `MOCK_READY_FILE`    — touched when the turn is in flight (after `item/started`).
 * - `MOCK_CODEX_TURN_STATUS` — terminal status: `completed` (default) | `interrupted` | `failed` |
 *                          `contextWindowExceeded` (a failed turn carrying that `codexErrorInfo`).
 * - `MOCK_CODEX_COMMENTARY` — if `1`, first stream a `commentary`-phase message (not the final answer).
 * - `MOCK_CODEX_APPROVAL` — `command` | `file` | `permissions`: before the answer, send the matching
 *                          `item/<kind>/requestApproval` request and apply the decision. `accept` runs on;
 *                          `decline` runs on with the item declined; `cancel` ends the turn `interrupted`.
 * - `MOCK_CODEX_APPROVAL_FILE` — every received approval decision is appended as `decision <value>`.
 * - `MOCK_CODEX_STEER_UNSUPPORTED` — if `1`, `turn/steer` answers -32601 Method not found.
 * - `MOCK_STEER_FILE`    — every accepted `turn/steer` appends `steer <threadId> <text>`.
 * - `MOCK_CANCEL_FILE`   — every `turn/interrupt` appends `interrupt <threadId> <turnId>`.
 * - `MOCK_REQUEST_FILE`  — every `thread/*` and `turn/start` request appends its JSON params (one line).
 * - `MOCK_CRASH_ON_INITIALIZE` — exit(1) on `initialize`.
 *
 * @module dsh-acp-resume/tests/mock-codex-server
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

type Json = Record<string, unknown>
interface ThreadRecord { cwd: string; prompts: string[] }

const env = process.env
const STORE = env['MOCK_SESSION_STORE']
const log = (file: string | undefined, line: string): void => { if (file !== undefined) appendFileSync(file, `${line}\n`) }

const threads = new Map<string, ThreadRecord>()
const loadStore = (): void => {
  if (STORE === undefined || !existsSync(STORE)) return
  for (const [id, record] of Object.entries(JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, ThreadRecord>)) threads.set(id, record)
}
const saveStore = (): void => { if (STORE !== undefined) writeFileSync(STORE, JSON.stringify(Object.fromEntries(threads))) }

const send = (message: Json): void => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
const reply = (id: unknown, result: unknown): void => send({ id, result })
const fail = (id: unknown, code: number, message: string): void => send({ id, error: { code, message } })
const notify = (method: string, params: Json): void => send({ method, params })

// Server → client requests (approvals) and their pending replies.
let serverRequestSeq = 0
const serverPending = new Map<string, (message: Json) => void>()
const askClient = (method: string, params: Json): Promise<Json> => new Promise((resolve) => {
  const id = `srv-${++serverRequestSeq}`
  serverPending.set(id, resolve)
  send({ id, method, params })
})

interface ActiveTurn { threadId: string; turnId: string; interrupted: boolean; wake: () => void }
let active: ActiveTurn | undefined
let itemSeq = 0

/** Wait `ms` (or forever when undefined), ended early by an interrupt. */
const interruptibleWait = (turn: ActiveTurn, ms: number | undefined): Promise<void> => new Promise((resolve) => {
  const timer = ms === undefined ? undefined : setTimeout(resolve, ms)
  turn.wake = () => { if (timer !== undefined) clearTimeout(timer); resolve() }
  if (turn.interrupted) turn.wake()
})

const userMessage = (turn: ActiveTurn, text: string): void => {
  const item = { type: 'userMessage', id: `item-${++itemSeq}`, content: [{ type: 'text', text, text_elements: [] }] }
  notify('item/started', { threadId: turn.threadId, turnId: turn.turnId, item })
  notify('item/completed', { threadId: turn.threadId, turnId: turn.turnId, item })
}

const finishTurn = (turn: ActiveTurn, status: string, errorInfo?: string): void => {
  const failed = status === 'failed' || errorInfo !== undefined
  notify('turn/completed', {
    threadId: turn.threadId,
    turn: {
      id: turn.turnId,
      status: failed ? 'failed' : status,
      ...(failed ? { error: { message: 'mock failure', codexErrorInfo: errorInfo ?? 'other' } } : {}),
    },
  })
  if (active === turn) active = undefined
}

const streamMessage = (turn: ActiveTurn, text: string, phase: string): void => {
  const itemId = `item-${++itemSeq}`
  notify('item/started', { threadId: turn.threadId, turnId: turn.turnId, item: { type: 'agentMessage', id: itemId, text: '', phase } })
  const mid = Math.ceil(text.length / 2)
  for (const delta of [text.slice(0, mid), text.slice(mid)]) {
    if (delta !== '') notify('item/agentMessage/delta', { threadId: turn.threadId, turnId: turn.turnId, itemId, delta })
  }
  notify('item/completed', { threadId: turn.threadId, turnId: turn.turnId, item: { type: 'agentMessage', id: itemId, text, phase } })
}

const APPROVAL_METHODS: Record<string, string> = {
  command: 'item/commandExecution/requestApproval',
  file: 'item/fileChange/requestApproval',
  permissions: 'item/permissions/requestApproval',
}

const runTurn = async (turn: ActiveTurn, prompt: string, record: ThreadRecord): Promise<void> => {
  notify('turn/started', { threadId: turn.threadId, turn: { id: turn.turnId, status: 'inProgress' } })
  userMessage(turn, prompt)
  if (env['MOCK_READY_FILE'] !== undefined) writeFileSync(env['MOCK_READY_FILE'], 'ready')
  const delay = env['MOCK_CODEX_DELAY_MS']
  if (env['MOCK_HANG'] === '1') await interruptibleWait(turn, undefined)
  else if (delay !== undefined) await interruptibleWait(turn, Number(delay))
  if (turn.interrupted) return finishTurn(turn, 'interrupted')

  const approval = env['MOCK_CODEX_APPROVAL']
  const approvalMethod = approval === undefined ? undefined : APPROVAL_METHODS[approval]
  if (approvalMethod !== undefined) {
    const itemId = `item-${++itemSeq}`
    const answer = await askClient(approvalMethod, {
      threadId: turn.threadId,
      turnId: turn.turnId,
      itemId,
      availableDecisions: ['accept', 'acceptWithExecpolicyAmendment', 'cancel'],
      ...(approval === 'command' ? { command: 'echo mock' } : {}),
    })
    const result = (answer['result'] ?? {}) as Json
    const decision = typeof result['decision'] === 'string' ? result['decision'] : 'none'
    log(env['MOCK_CODEX_APPROVAL_FILE'], `decision ${decision}`)
    if (decision === 'cancel' || decision === 'none') return finishTurn(turn, 'interrupted')
  }
  if (turn.interrupted) return finishTurn(turn, 'interrupted')

  const previous = record.prompts.at(-2)
  const text = env['MOCK_REMEMBER'] === '1' ? `remember:${previous ?? 'none'}` : (env['MOCK_TEXT'] ?? 'mock codex answer')
  if (env['MOCK_CODEX_COMMENTARY'] === '1') streamMessage(turn, 'thinking about it', 'commentary')
  streamMessage(turn, text, 'final_answer')
  const status = env['MOCK_CODEX_TURN_STATUS'] ?? 'completed'
  if (status === 'contextWindowExceeded') finishTurn(turn, 'failed', 'contextWindowExceeded')
  else finishTurn(turn, status)
}

const inputText = (params: Json): string => {
  const input = Array.isArray(params['input']) ? params['input'] as Json[] : []
  return input.map(part => (typeof part['text'] === 'string' ? part['text'] : '')).join('\n')
}

const handle = (id: unknown, method: string, params: Json): void => {
  switch (method) {
    case 'initialize':
      if (env['MOCK_CRASH_ON_INITIALIZE'] === '1') process.exit(1)
      return reply(id, { userAgent: 'mock-codex/0.0.0' })
    case 'model/list':
      return reply(id, { data: [{ id: 'mock-model', model: 'mock-model', hidden: false }, { id: 'mock-model-hidden', model: 'mock-model-hidden', hidden: true }] })
    case 'thread/start': {
      log(env['MOCK_REQUEST_FILE'], `thread/start ${JSON.stringify(params)}`)
      const threadId = `thr-${randomUUID()}`
      const persist = params['ephemeral'] === false
      if (persist) loadStore()
      threads.set(threadId, { cwd: String(params['cwd'] ?? ''), prompts: [] })
      if (persist) saveStore()
      return reply(id, { thread: { id: threadId, path: persist ? `/mock/threads/${threadId}.jsonl` : null } })
    }
    case 'thread/resume': {
      log(env['MOCK_REQUEST_FILE'], `thread/resume ${JSON.stringify(params)}`)
      loadStore()
      const threadId = String(params['threadId'] ?? '')
      if (env['MOCK_LOAD_MISSING'] === '1' || !threads.has(threadId)) return fail(id, -32600, `no rollout found for thread id ${threadId}`)
      return reply(id, { thread: { id: threadId, turns: threads.get(threadId)?.prompts.map((_, index) => ({ id: `old-${index}` })) ?? [] } })
    }
    case 'turn/start': {
      log(env['MOCK_REQUEST_FILE'], `turn/start ${JSON.stringify(params)}`)
      const threadId = String(params['threadId'] ?? '')
      const record = threads.get(threadId)
      if (record === undefined) return fail(id, -32600, `thread not found: ${threadId}`)
      if (active !== undefined) return fail(id, -32600, 'a turn is already in progress')
      const prompt = inputText(params)
      record.prompts.push(prompt)
      saveStore()
      const turn: ActiveTurn = { threadId, turnId: `turn-${randomUUID()}`, interrupted: false, wake: () => {} }
      active = turn
      reply(id, { turn: { id: turn.turnId, status: 'inProgress' } })
      void runTurn(turn, prompt, record)
      return
    }
    case 'turn/steer': {
      if (env['MOCK_CODEX_STEER_UNSUPPORTED'] === '1') return fail(id, -32601, 'Method not found')
      if (active === undefined || params['expectedTurnId'] !== active.turnId) return fail(id, -32600, 'expectedTurnId does not match the active turn')
      const text = inputText(params)
      log(env['MOCK_STEER_FILE'], `steer ${active.threadId} ${text}`)
      userMessage(active, text)
      return reply(id, { turnId: active.turnId })
    }
    case 'turn/interrupt': {
      log(env['MOCK_CANCEL_FILE'], `interrupt ${String(params['threadId'])} ${String(params['turnId'])}`)
      reply(id, {})
      if (active !== undefined && active.turnId === params['turnId']) {
        active.interrupted = true
        active.wake()
      }
      return
    }
    default:
      return fail(id, -32601, 'Method not found')
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  let message: Json
  try { message = JSON.parse(line) as Json } catch { return }
  const method = message['method']
  const id = message['id']
  if (typeof method === 'string') {
    if (id !== undefined && id !== null) handle(id, method, (message['params'] ?? {}) as Json)
    return
  }
  // A reply to one of our server requests.
  if (typeof id === 'string') {
    const resolve = serverPending.get(id)
    serverPending.delete(id)
    resolve?.(message)
  }
})
lines.on('close', () => { process.exit(0) })
