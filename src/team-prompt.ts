/** Dispatcher coordination instructions resolved against the current Agent and admitted tools (D36).
 * @module dsh-acp-resume/team-prompt
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** Cross-role dispatch guidance shared by all configured tool prefixes. */
export const TEAM_INSTRUCTIONS = "When coordinating named roles, relay any result that changes another role's next action. "
  + 'Include the source role, the finding, and what the recipient needs to do. Send a self-contained summary.'

/** Register on the optional prompt fiber inside the host tools scope. */
export function registerTeamPrompt(ctx: Context, teamName: string): void {
  ctx.systemPrompt.section({
    name: 'acp-resume:team',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
    text: ({ agent, scope, toolSet }) => {
      if (!agent || ctx.agentPresets.composedPreset(agent.ctx) !== 'acp-dispatcher') return ''
      return ctx.tools.get(teamName, scope, toolSet) ? TEAM_INSTRUCTIONS : ''
    },
  })
}
