/**
 * Pure unit tests for host-side failure classification (D50): Codex
 * `usageLimitExceeded`, generic JSON-RPC/HTTP quota patterns (awaiting real
 * agy/kiro sample calibration), strict non-false-positive boundaries, and
 * empty / non-string / malformed inputs.
 *
 * @module dsh-acp-resume/tests/failure-class.spec
 */

import { describe, expect, it } from 'vitest'
import { RequestError } from '@agentclientprotocol/sdk'
import { classifyFailure, CODEX_QUOTA_ERROR_INFO, QUOTA_MESSAGE_PATTERN } from '../src/failure-class.ts'

describe('classifyFailure (D50)', () => {
  it('recognizes Codex usageLimitExceeded as quota (bare string and one-key object)', () => {
    expect(classifyFailure({ codexErrorInfo: CODEX_QUOTA_ERROR_INFO })).toBe('quota')
    expect(classifyFailure(Object.assign(new Error('anything'), { codexErrorInfo: 'usageLimitExceeded' }))).toBe('quota')
    expect(classifyFailure({ codexErrorInfo: { usageLimitExceeded: { resetsAt: 123 } } })).toBe('quota')
  })

  it('recognizes inferred generic JSON-RPC / HTTP quota patterns across message, data, and details', () => {
    const samples = [
      { message: 'You have hit your usage limit for this billing period' },
      { message: 'HTTP 429: Rate limit exceeded, please retry later' },
      { message: 'API quota exceeded for project' },
      { message: 'Error code: insufficient_quota' },
      { message: 'Monthly overage spending limit reached' },
      { message: 'You have exceeded your usage allowance' },
      new RequestError(-32603, 'Internal error', { detail: 'Quota Exceeded on upstream' }),
      Object.assign(new Error('Upstream failed'), { details: 'rate limit exceeded' }),
      { data: ['wrapped', { nested: 'insufficient_quota' }] },
    ]
    for (const sample of samples) {
      expect(classifyFailure(sample)).toBe('quota')
    }
    expect(QUOTA_MESSAGE_PATTERN.flags).toContain('i')
  })

  it('does not misclassify ordinary errors (-32603 internal error, session not found, ENOENT, or unrelated limits) as quota', () => {
    const nonQuota = [
      new RequestError(-32603, 'Internal error'),
      { code: -32603, message: 'Internal error', data: { reason: 'unexpected server crash' } },
      new RequestError(-32600, 'session not found: sess-123'),
      new Error('no rollout found for thread id thr-456'),
      Object.assign(new Error('spawn kiro-cli ENOENT'), { code: 'ENOENT' }),
      { codexErrorInfo: 'contextWindowExceeded', message: 'context window exceeded' },
      { codexErrorInfo: 'other', message: 'mock failure' },
      { message: 'Authentication required' },
      { message: 'Request timed out (ETIMEDOUT)' },
      { message: 'file size limit reached' },
      // Object keys alone must not trigger a match when values are non-strings.
      { data: { quota_exceeded: false, usage_limit: 0 } },
    ]
    for (const sample of nonQuota) {
      expect(classifyFailure(sample)).toBeUndefined()
    }
  })

  it('returns undefined safely on empty, non-string, non-object, and circular inputs', () => {
    const circular: Record<string, unknown> = { message: 'ordinary failure' }
    circular['data'] = circular

    const inputs: unknown[] = [
      undefined,
      null,
      '',
      'quota exceeded',
      0,
      42,
      true,
      false,
      [],
      ['quota exceeded'],
      {},
      { message: '' },
      { message: null, data: undefined, details: 123, codexErrorInfo: 0 },
      { codexErrorInfo: ['usageLimitExceeded'] },
      { codexErrorInfo: { usageLimitExceeded: true, extra: true } },
      circular,
    ]
    for (const input of inputs) {
      expect(classifyFailure(input)).toBeUndefined()
    }
  })
})
