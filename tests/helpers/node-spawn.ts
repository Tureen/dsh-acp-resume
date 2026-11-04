/**
 * Minimal SubprocessHandle adapter over node:child_process for the
 * connection-level tests: exposes exactly the surface src/connection.ts and
 * src/run.ts consume (stdin/stdout pipes, done outcome, bounded waitForExit,
 * terminate escalation). Test-only — production spawns ride the real seam
 * through `spec.spawn`.
 *
 * @module dsh-acp-resume/tests/helpers/node-spawn
 */

import { spawn } from 'node:child_process'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

export function nodeSpawn(spec: SubprocessSpawnSpec): SubprocessHandle {
  const argv = spec.argv
  // The seam's stdio is an object disposition map; node expects the array form.
  const stdio = spec.stdio === undefined
    ? ['pipe', 'pipe', 'inherit']
    : [spec.stdio.stdin, spec.stdio.stdout, spec.stdio.stderr] as const
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: spec.cwd,
    stdio: [...stdio],
    env: { ...process.env, ...spec.env },
  })
  const graceMs = spec.graceMs ?? 3_000
  let terminated = false
  const exitDone = new Promise<SubprocessOutcome>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolve({ exitCode: code, signal: signal ?? null })
    })
  })
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  const handle: SubprocessHandle = {
    get stdin() { return child.stdin },
    get stdout() { return child.stdout },
    get stderr() { return child.stderr },
    done: exitDone,
    async waitForExit(signal?: AbortSignal): Promise<boolean> {
      if (signal === undefined) {
        await exited
        return true
      }
      const aborted = new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => { resolve(false) }, { once: true })
        if (signal.aborted) resolve(false)
      })
      return await Promise.race([exited.then(() => true), aborted])
    },
    terminate(): void {
      if (terminated) return
      terminated = true
      child.kill('SIGTERM')
      setTimeout(() => { child.kill('SIGKILL') }, graceMs).unref()
    },
  }
  return handle
}
