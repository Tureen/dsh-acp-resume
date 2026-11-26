/** Read model selection facts from ACP replies and config_option_update notifications.
 * A complete option list replaces earlier facts, including options the new model removed.
 * @module dsh-acp-resume/acp-reported-settings
 */
import type { ReportedSettings } from './backend-status.js'

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
