/**
 * Codex approval policy (D25). Codex asks before running a command, applying a
 * file change, or widening permissions through three server requests
 * (`item/commandExecution|fileChange|permissions/requestApproval`) answered with
 * a `decision`. This module maps the automatic policies (`allow` → `accept`,
 * `reject` → `decline`) and the `ask` bridge: the request becomes an ACP-shaped
 * permission request (accept / decline / cancel options), so the existing
 * `userQuestionPermissionResolver` asks the host user and nothing is duplicated;
 * the selected option id maps back to the Codex decision. Everything else (no
 * bridge, an aborted turn, an invalid or cancelled answer, a resolver failure)
 * fails closed as `cancel`, which interrupts the whole turn.
 *
 * @module dsh-acp-resume/codex-approval
 */

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { cancelledPermissionResponse, type PermissionPolicy, type PermissionRequestResolver } from './permission-request.js'

/** The reply values this adapter ever sends back. */
export type CodexDecision = 'accept' | 'decline' | 'cancel'

const APPROVAL_METHOD = /^item\/(commandExecution|fileChange|permissions)\/requestApproval$/

/** Whether `method` is one of the three Codex approval requests. */
export function isCodexApprovalMethod(method: string): boolean {
  return APPROVAL_METHOD.test(method)
}

function text(value: unknown, max = 1_000): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  const chars = Array.from(value)
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…`
}

/** Offered decisions: `availableDecisions` filters `accept`; `decline` and `cancel` are always offered. */
function acceptOffered(params: Record<string, unknown>): boolean {
  const available = params['availableDecisions']
  return !Array.isArray(available) || available.includes('accept')
}

/** Translate one Codex approval request into an ACP-shaped permission request. */
export function toCodexPermissionRequest(method: string, params: Record<string, unknown>): RequestPermissionRequest {
  const kind = APPROVAL_METHOD.exec(method)?.[1] ?? 'permissions'
  const itemId = text(params['itemId'], 200) ?? 'item'
  const title = kind === 'commandExecution'
    ? 'Codex requests to run a command'
    : kind === 'fileChange' ? 'Codex requests to change files' : 'Codex requests additional permissions'
  const details = [
    kind === 'commandExecution' ? text(params['command']) : undefined,
    kind === 'commandExecution' && text(params['cwd']) !== undefined ? `cwd: ${text(params['cwd'])}` : undefined,
    kind === 'fileChange' && text(params['grantRoot']) !== undefined ? `grant root: ${text(params['grantRoot'])}` : undefined,
    text(params['reason']) === undefined ? undefined : `reason: ${text(params['reason'])}`,
  ].filter((value): value is string => value !== undefined)
  return {
    sessionId: text(params['threadId'], 200) ?? 'codex',
    toolCall: {
      toolCallId: `codex-${itemId}`,
      title,
      kind: kind === 'commandExecution' ? 'execute' : kind === 'fileChange' ? 'edit' : 'other',
      content: details.map(detail => ({ type: 'content', content: { type: 'text', text: detail } })),
    },
    options: [
      ...(acceptOffered(params) ? [{ optionId: 'accept', name: 'Allow', kind: 'allow_once' as const }] : []),
      { optionId: 'decline', name: 'Reject this step (the turn continues)', kind: 'reject_once' as const },
      { optionId: 'cancel', name: 'Cancel the whole turn', kind: 'reject_once' as const },
    ],
  }
}

/**
 * Decide one approval request.
 * @param policy - the backend's `permission` setting.
 * @param method - the `item/<kind>/requestApproval` method.
 * @param params - the request params.
 * @param signal - the in-flight turn's signal; absent means the request arrived outside a turn.
 * @param resolver - the host-user bridge for `ask`.
 */
export async function resolveCodexApproval(
  policy: PermissionPolicy,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  resolver: PermissionRequestResolver | undefined,
): Promise<CodexDecision> {
  if (signal === undefined || signal.aborted) return 'cancel'
  if (policy === 'allow') return 'accept'
  if (policy === 'reject') return 'decline'
  if (resolver === undefined) return 'cancel'
  const request = toCodexPermissionRequest(method, params)
  let response
  try {
    response = await resolver(request, signal)
  } catch {
    response = cancelledPermissionResponse()
  }
  const optionId: unknown = Reflect.get(response.outcome, 'optionId')
  // Only an exact offered option is honored.
  const offered = request.options.some(option => option.optionId === optionId)
  return offered && (optionId === 'accept' || optionId === 'decline') ? optionId : 'cancel'
}
