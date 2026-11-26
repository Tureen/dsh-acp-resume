/** Read model selection facts from ACP replies and config_option_update notifications.
 * A complete option list replaces earlier facts, including options the new model removed.
 * @module dsh-acp-resume/acp-reported-settings
 */
import type { ReportedSettings } from './backend-status.js'

import type { Selection, SessionChoices } from './chat-options.js'

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Options can be flat or grouped. Display names apply only to the reported current id. */
function optionName(list: unknown, id: string): string | undefined {
  if (!Array.isArray(list)) return
  for (const item of list) {
    const row = object(item)
    if (row?.value === id) return string(row.name)
    if (Array.isArray(row?.options)) {
      const match = row.options.find(child => object(child)?.value === id)
      if (match) return string(object(match)?.name)
    }
  }
}

/** Undefined means no report. An empty object means the backend reported no relevant options. */
export function readAcpSettings(reply: unknown): ReportedSettings | undefined {
  const data = object(reply)
  const options = data?.configOptions
  const legacy = object(data?.models)
  const legacyId = string(legacy?.currentModelId)
  if (!Array.isArray(options) && !legacyId) return
  const rows = Array.isArray(options) ? options.map(object) : []
  const model = rows.find(o => o?.id === 'model')
  const modelId = string(model?.currentValue) ?? legacyId
  const effort = string(rows.find(o => o?.id === 'thought_level' || o?.id === 'effortLevel')?.currentValue)
  const legacyMatch = modelId && Array.isArray(legacy?.availableModels)
    ? legacy.availableModels.find(m => object(m)?.modelId === modelId) : undefined
  const modelName = modelId && (optionName(model?.options, modelId) ?? string(object(legacyMatch)?.name))
  return { ...(modelId && { model: modelId }), ...(modelName && { modelName }), ...(effort && { effort }) }
}

/** Read offered values only from the backend. ACP select options can have groups. */
function selection(row: Record<string, unknown> | undefined): Selection | undefined {
  if (!row) return
  const choices = new Map<string, string>()
  function add(item: unknown) {
    const entry = object(item)
    const value = string(entry?.value)
    if (value) choices.set(value, string(entry?.name) ?? value)
  }
  if (Array.isArray(row.options)) for (const item of row.options) {
    const group = object(item)?.options
    if (Array.isArray(group)) group.forEach(add)
    else add(item)
  }
  const current = string(row.currentValue)
  return { ...(current && { current }), options: Array.from(choices, ([value, name]) => ({ value, name })) }
}

export function readSessionChoices(reply: unknown): SessionChoices | undefined {
  const rows = object(reply)?.configOptions
  if (!Array.isArray(rows)) return
  const options = rows.map(object)
  const effort = options.find(row => row?.id === 'effortLevel' || row?.id === 'thought_level')
  const model = selection(options.find(row => row?.id === 'model'))
  const effortId = string(effort?.id)
  return { ...(model && { model }), ...(effortId && { effortId }), effort: selection(effort) ?? 'not-offered' }
}
