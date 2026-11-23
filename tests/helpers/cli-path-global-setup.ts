import { mkdtempSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'

export default function setup(project: TestProject): () => void {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-acp-test-path-'))
  project.provide('isolatedCliPath', directory)
  return () => { rmdirSync(directory) }
}

declare module 'vitest' {
  export interface ProvidedContext {
    isolatedCliPath: string
  }
}
