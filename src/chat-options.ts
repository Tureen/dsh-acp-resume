/** Read-only wire view of one live connection's reported session choices (D44). @module */
export interface Selection {
  readonly current?: string
  readonly options: readonly { value: string; name: string }[]
}

export interface SessionChoices {
  readonly model?: Selection
  readonly effort?: Selection | 'not-offered'
  readonly effortId?: string
}

export interface ChatOptions extends SessionChoices {
  readonly backend: string
  readonly supported: boolean
  readonly canChange: boolean
  readonly reason?: 'released' | 'running' | 'changing' | 'codex session-level switch is not available yet'
}
