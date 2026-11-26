/** Model and effort rows from the agy 1.5.13 model-switch probe, limited to the three selected models. */
export const neon = 'gemini-4-neon'
export const sonnet = 'claude-sonnet-5-5'
export const orchestrator = 'gemini-pro-orchestrator-neon'
const models = [
  { value: neon, name: 'Gemini 4 Neon' },
  { value: sonnet, name: 'Claude Sonnet 5.5' },
  { value: orchestrator, name: 'Orchestrator (Neon)' },
]
const efforts = [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra' }]
export function configOptions(model: string) {
  const modelRow = { type: 'select', category: 'model', id: 'model', name: 'Model', currentValue: model, options: models }
  return model === orchestrator ? [modelRow] : [modelRow, {
    type: 'select', category: 'thought_level', id: 'thought_level', name: 'Thinking Level', currentValue: 'high',
    options: model === sonnet ? efforts.slice(0, 3) : efforts,
  }]
}
export function selectionEnv() {
  return { MOCK_CONFIG_OPTIONS: JSON.stringify(configOptions(neon)),
    MOCK_MODEL_CATALOGS: JSON.stringify(Object.fromEntries(models.map(({ value }) => [value, configOptions(value)]))) }
}
