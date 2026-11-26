/**
 * Evidence-bounded stable CLI releases for built-in backend discovery. This
 * module does not classify commands or wrappers, probe the protocol, or decide
 * whether a particular login, model, or command line works. See
 * `docs/backend-compatibility.md` for the bounds and known limitations.
 * @module dsh-acp-resume/backend-compatibility
 */

/** Backend families whose upstream stable releases have a supported range. */
export type KnownBackendKind = 'kiro-v2' | 'kiro-v3' | 'codex' | 'agy'

type VersionInterval = readonly [minInclusive: string, maxExclusive: string]

// End at the next unverified minor line, not at the last reviewed patch.
const KIRO_2_X = ['2.36.0', '2.38.0'] as const
// Kiro V3 3.6.0 was verified in D34 (2026-11-25). Admit the 3.6 line; reverify before admitting 3.7.
const RELEASES = {
  'kiro-v2': [KIRO_2_X, ['3.0.0', '3.6.0']],
  'kiro-v3': [KIRO_2_X, ['3.0.0', '3.7.0']],
  codex: [['0.154.0', '0.172.0']],
  agy: [['1.5.4', '1.6.0']],
} as const satisfies Readonly<Record<KnownBackendKind, readonly VersionInterval[]>>

export const KNOWN_BACKEND_KINDS: readonly KnownBackendKind[] = Object.freeze(Object.keys(RELEASES) as KnownBackendKind[])

/** Keep the publisher's documented and the runtime's accepted bounds identical. */
export function backendSupportRange(kind: KnownBackendKind): string {
  return (RELEASES[kind] as readonly VersionInterval[]).map(([min, max]) => `>=${min} <${max}`).join(' || ')
}

const NUMERIC = '(?:0|[1-9][0-9]*)'
const CORE = `${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}`
const PRERELEASE_PART = `(?:${NUMERIC}|[0-9]*[a-z-][0-9a-z-]*)`
const BUILD_PART = '[0-9a-z-]+'
const SEMVER = `${CORE}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+${BUILD_PART}(?:\\.${BUILD_PART})*)?`
const RELEASE = new RegExp(`^(?:v)?(${CORE})$`, 'i')
const VERSION_LINE = new RegExp(
  `^(?:(?:kiro-cli|codex(?:-cli)?|agy|antigravity(?: cli| acp server)?)[ \\t]+(?:version[ \\t]+)?)?v?(${SEMVER})$`,
  'i',
)

/** Parse a complete CLI version line, not a version embedded in a diagnostic. */
export function parseBackendVersion(output: string): string | undefined {
  let version: string | undefined
  for (const line of output.split(/\r?\n/)) {
    const match = VERSION_LINE.exec(line.trim())?.[1]
    if (match === undefined) continue
    if (version !== undefined && version !== match) return undefined
    version = match
  }
  return version
}

function compareReleases(left: string, right: string): number {
  const rhs = right.split('.')
  for (const [index, part] of left.split('.').entries()) {
    const other = rhs[index]!
    if (part.length !== other.length) return part.length - other.length
    if (part !== other) return part < other ? -1 : 1
  }
  return 0
}

/** Check a stable release against the documented half-open intervals. */
export function backendCompatibility(kind: KnownBackendKind, version: string): { readonly supported: boolean; readonly range: string } {
  const intervals: readonly VersionInterval[] = RELEASES[kind]
  const release = RELEASE.exec(version)?.[1]
  return {
    supported: release !== undefined && intervals.some(([min, max]) => compareReleases(release, min) >= 0 && compareReleases(release, max) < 0),
    range: backendSupportRange(kind),
  }
}
