/**
 * Fixed, model-facing guidance for a missing configured ACP executable. The
 * underlying error remains available as a cause and through the host sink;
 * configuration paths and PATH contents never enter model-visible text.
 * @module dsh-acp-resume/command-not-found
 */

/** Actionable wording appended to an ENOENT process-start failure. */
export const COMMAND_NOT_FOUND_GUIDANCE = "ACP agent command was not found (ENOENT). Install the default agent (kiro-cli), or override command and args in a top-level config layer. For agents that reject --agent-engine, set agentEngine: 'none'. See README Configuration."

/** True only for the platform's structured missing-executable error. */
export function isCommandNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}
