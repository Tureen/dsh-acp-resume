/**
 * ACP permission-request policy and the `permission: ask` bridge to the
 * host's user-questions service. Invalid, unavailable, and cancelled answers
 * fail closed as ACP `cancelled`; only an exact offered option id is selected.
 * @module dsh-acp-resume/permission-request
 */

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionAnswer, AskUserQuestionRequest, UserQuestionService } from '@deepseek-ai/dsh-user-questions'

/** How a child `session/request_permission` is answered. */
export type PermissionPolicy = 'allow' | 'reject' | 'ask'

/** Per-request bridge supplied by the one-shot provider or a pooled turn. */
export type PermissionRequestResolver = (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>

/** ACP's fail-closed response when no valid human selection is available. */
export function cancelledPermissionResponse(): RequestPermissionResponse {
  return { outcome: { outcome: 'cancelled' } }
}

/** Whether an ACP response actually grants an offered allow-shaped option. */
export function permissionWasAllowed(request: RequestPermissionRequest, response: RequestPermissionResponse): boolean {
  const optionId = Reflect.get(response.outcome, 'optionId')
  if (typeof optionId !== 'string') return false
  const selected = request.options.find(option => option.optionId === optionId)
  return selected?.kind === 'allow_once' || selected?.kind === 'allow_always'
}

/** Bound user-question service sufficient for the bridge. */
type Questions = Pick<UserQuestionService, 'ask'>

function cap(value: string, max = 2_000): string {
  const chars = Array.from(value)
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…`
}

/** Safe text-only summary of ACP tool content; diffs and opaque values stay out of the question. */
function textContent(request: RequestPermissionRequest): string[] {
  const entries = request.toolCall.content
  if (!Array.isArray(entries)) return []
  const text: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Reflect.get(entry, 'type') !== 'content') continue
    const content = Reflect.get(entry, 'content')
    if (typeof content !== 'object' || content === null || Reflect.get(content, 'type') !== 'text') continue
    const value = Reflect.get(content, 'text')
    if (typeof value === 'string' && value !== '') text.push(cap(value))
  }
  return text
}

interface QuestionMapping {
  readonly id: string
  readonly request: AskUserQuestionRequest
  readonly optionIds: ReadonlyMap<string, string>
}

/** Map one ACP request to a generic, single-choice host question. */
export function toPermissionQuestion(request: RequestPermissionRequest): QuestionMapping {
  const id = `acp-permission-${request.toolCall.toolCallId}`
  const optionIds = new Map<string, string>()
  const options = request.options.map((option, index) => {
    const label = `${option.name === '' ? 'Option' : option.name} (${option.kind}, option ${index + 1})`
    optionIds.set(label, option.optionId)
    return { label, description: option.kind }
  })
  const detail = [
    ...(typeof request.toolCall.name === 'string' && request.toolCall.name !== '' ? [`Tool: ${cap(request.toolCall.name, 240)}`] : []),
    ...(typeof request.toolCall.kind === 'string' ? [`Kind: ${request.toolCall.kind}`] : []),
    ...textContent(request).map(value => `Details: ${value}`),
  ].join('\n')
  return {
    id,
    optionIds,
    request: {
      questions: [{
        id,
        header: 'ACP permission request',
        question: typeof request.toolCall.title === 'string' && request.toolCall.title !== ''
          ? cap(request.toolCall.title, 500)
          : 'An external ACP subagent requests permission to continue.',
        ...(detail === '' ? {} : { detail }),
        options,
      }],
    },
  }
}

/** Convert only one exact single-choice answer into its original ACP option id. */
export function answerPermissionQuestion(answer: AskUserQuestionAnswer, mapping: QuestionMapping): RequestPermissionResponse {
  if (answer.answers.length !== 1) return cancelledPermissionResponse()
  const item = answer.answers[0]
  if (item === undefined || item.id !== mapping.id || item.custom !== undefined || item.selected.length !== 1) {
    return cancelledPermissionResponse()
  }
  const optionId = mapping.optionIds.get(item.selected[0] ?? '')
  return optionId === undefined
    ? cancelledPermissionResponse()
    : { outcome: { outcome: 'selected', optionId } }
}

/** Build a fail-closed interactive resolver for one local calling agent. */
export function userQuestionPermissionResolver(questions: Questions | undefined, agent: Agent | undefined): PermissionRequestResolver {
  return async (request, signal) => {
    if (questions === undefined || signal.aborted) return cancelledPermissionResponse()
    const mapping = toPermissionQuestion(request)
    const answer = questions.ask({ ...mapping.request, ...(agent === undefined ? {} : { agent }), signal })
      .then(result => answerPermissionQuestion(result, mapping), () => cancelledPermissionResponse())
    let onAbort: (() => void) | undefined
    const aborted = new Promise<RequestPermissionResponse>((resolve) => {
      onAbort = () => { resolve(cancelledPermissionResponse()) }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    try {
      return await Promise.race([answer, aborted])
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
}

/** Apply an automatic policy or the supplied interactive bridge. */
export async function resolvePermissionRequest(
  policy: PermissionPolicy,
  request: RequestPermissionRequest,
  signal: AbortSignal,
  resolver?: PermissionRequestResolver,
): Promise<RequestPermissionResponse> {
  if (policy === 'allow') {
    const allow = request.options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
    if (allow !== undefined) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
  }
  if (policy === 'ask' && resolver !== undefined) return resolver(request, signal)
  return cancelledPermissionResponse()
}
