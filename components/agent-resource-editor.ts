import type { SubagentResourceSelection } from "../lib/subagent-resource-selection";

/** Keep unfinished input while typing; null explicitly resets an existing API selector list. */
export function normalizeAgentResourceDraft<T extends SubagentResourceSelection>(draft: T) {
  const selection: Record<keyof SubagentResourceSelection, string[] | null> = {
    skillNames: null, extensionPaths: null, mcpServers: null, mcpTools: null,
  };
  for (const key of ["skillNames", "extensionPaths", "mcpServers", "mcpTools"] as const) {
    if (draft[key] !== undefined) selection[key] = [...new Set(draft[key].map(value => value.trim()).filter(Boolean))];
  }
  return { ...draft, ...selection };
}
