/** Configuration facts shared by the panel Remote and the browser (D35).
 * @module dsh-acp-resume/panel-features
 */
export interface PanelFeatures {
  /** Whether the host configuration enables persistent chat tools. */
  readonly chatToolsEnabled: boolean
  /** Whether the host configuration enables workflow execution. */
  readonly workflowEnabled: boolean
  /** Model-facing name of the persistent chat creation tool. */
  readonly startToolName: string
}
