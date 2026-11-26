import { describe, expect, it } from 'vitest'
import { backendCompatibility, parseBackendVersion, type KnownBackendKind } from '../src/backend-compatibility.ts'

const KIRO_RANGE = '>=2.36.0 <2.38.0 || >=3.0.0 <3.6.0'
const CODEX_RANGE = '>=0.154.0 <0.172.0'

const cases: readonly {
  readonly kind: KnownBackendKind
  readonly range: string
  readonly within: readonly string[]
  readonly outside: readonly string[]
}[] = [
  {
    kind: 'kiro-v2', range: KIRO_RANGE,
    within: ['2.36.0', '2.37.0', '2.37.1', '2.37.2', '3.0.0', '3.2.1', '3.5.0', '3.5.1'],
    outside: ['2.35.9', '2.38.0', '2.99.0', '3.6.0', '3.10.0', '4.0.0'],
  },
  {
    kind: 'kiro-v3', range: '>=2.36.0 <2.38.0 || >=3.0.0 <3.7.0',
    within: ['2.36.0', '2.37.1', '2.37.10', '3.0.0', '3.5.0', '3.5.10', '3.6.0', '3.6.12'],
    outside: ['2.35.9', '2.38.0', '3.7.0'],
  },
  {
    kind: 'codex', range: CODEX_RANGE,
    within: ['0.154.0', '0.160.0', '0.171.0', '0.171.1', '0.171.10'],
    outside: ['0.153.99', '0.172.0', '0.172.1', '1.0.0'],
  },
  {
    kind: 'agy', range: '>=1.5.4 <1.6.0',
    within: ['1.5.4', '1.5.9', '1.5.10', '1.5.12', '1.5.13', '1.5.14'],
    outside: ['1.5.3', '1.6.0', '1.6.1', '2.0.0'],
  },
]

describe('backendCompatibility', () => {
  it.each(cases)('allows supported $kind patch releases up to the next unverified minor', ({ kind, range, within, outside }) => {
    for (const version of within) expect(backendCompatibility(kind, version)).toEqual({ supported: true, range })
    for (const version of outside) expect(backendCompatibility(kind, version)).toEqual({ supported: false, range })
  })

  it.each(['0.160', '0.0160.0', '0.160.0-rc.1', '0.160.0+custom.1', '0.160.0.1', 'codex-cli 0.160.0', ''])('does not classify %j as a supported stable release', (version) => {
    expect(backendCompatibility('codex', version)).toEqual({ supported: false, range: CODEX_RANGE })
  })

  it('allows a conventional v prefix and compares numeric components', () => {
    expect(backendCompatibility('agy', 'v1.5.10').supported).toBe(true)
    expect(backendCompatibility('agy', '1.5.10000000000000000').supported).toBe(true)
    expect(backendCompatibility('agy', '1.50.0').supported).toBe(false)
    expect(backendCompatibility('agy', '1.5.14-rc.1').supported).toBe(false)
    expect(backendCompatibility('agy', '1.6.0-rc.1').supported).toBe(false)
  })
})

describe('parseBackendVersion', () => {
  it.each([
    ['kiro-cli 2.37.1\n', '2.37.1'],
    ['warning: startup option includes 12.13.14\r\n kiro-cli 3.5.0\r\n', '3.5.0'],
    ['codex-cli 0.171.0', '0.171.0'],
    ['agy version v1.5.12', '1.5.12'],
    ['Antigravity CLI 1.5.9', '1.5.9'],
    ['1.5.14\n', '1.5.14'],
    ['codex-cli 0.172.0-alpha.1+git.012', '0.172.0-alpha.1+git.012'],
    ['kiro-cli v3.5.0\n3.5.0', '3.5.0'],
  ])('extracts a complete version line from %j', (output, expected) => {
    expect(parseBackendVersion(output)).toBe(expected)
  })

  it.each([
    '',
    'cannot start kiro-cli 2.37.1',
    'codex-cli 0.160.0 extra text',
    'wrapper version 0.160.0',
    'codex-cli 0.160',
    'codex-cli 0.160.0-rc.01',
    'codex-cli 0.160.0+bad..id',
    'codex-cli 0.0160.0',
    'codex-cli 0.160.0\n0.161.0',
  ])('does not take an ambiguous or malformed version from %j', (output) => {
    expect(parseBackendVersion(output)).toBeUndefined()
  })
})
