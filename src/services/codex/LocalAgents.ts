/** On-machine agents the plugin can drive. Each owns its login, tools, permissions and history. */
export const LOCAL_AGENTS = { codex: 'Codex', claude: 'Claude Code' } as const;
export type LocalAgentId = keyof typeof LOCAL_AGENTS;
export type TextExecutionBackend = 'systemsculpt' | LocalAgentId;
/** A native usage/billing rejection, identified by protocol fields rather than reply text. */
export class LocalAgentUsageLimitError extends Error {}
export function isLocalAgentId(value: unknown): value is LocalAgentId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCAL_AGENTS, value);
}
