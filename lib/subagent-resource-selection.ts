/** Profile selectors are resource loading choices, not an OS/extension permission boundary. */
export interface SubagentResourceSelection {
  /** Undefined uses loadSkills' legacy all/none behavior; [] selects no skills. */
  skillNames?: string[];
  /** Explicit extension files only; undefined uses loadExtensions' legacy discovery. */
  extensionPaths?: string[];
  /** Raw, exact mcp.json server names. Absent/empty connects no configured servers. */
  mcpServers?: string[];
  /** Raw server/tool selectors. Undefined selects all eligible tools; [] selects none. */
  mcpTools?: string[];
}

export const MAX_SUBAGENT_RESOURCE_SELECTORS = 64;
const SERVER = /^[A-Za-z0-9_-]+$/;
const SKILL = /^[A-Za-z0-9._-]+$/;
const EXTENSION_FILE = /\.(?:[cm]?js|tsx?)$/i;

export function validateResourceSelectors(value: unknown, kind: keyof SubagentResourceSelection): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SUBAGENT_RESOURCE_SELECTORS) {
    throw new Error(`${kind} must be an array of at most ${MAX_SUBAGENT_RESOURCE_SELECTORS} selectors`);
  }
  const maxLength = kind === "extensionPaths" ? 1024 : 256;
  return [...new Set(value.map((item: unknown) => {
    if (typeof item !== "string" || !item.trim() || item.length > maxLength || /[\x00-\x1f\x7f*]/.test(item)) {
      throw new Error(`Invalid ${kind} selector`);
    }
    const selector = item.trim();
    if (kind === "skillNames" && (!SKILL.test(selector) || selector.length > 64)) throw new Error("Invalid skillNames selector");
    if (kind === "mcpServers" && !SERVER.test(selector)) throw new Error("Invalid mcpServers selector");
    if (kind === "mcpTools") {
      const slash = selector.indexOf("/");
      if (slash < 1 || !SERVER.test(selector.slice(0, slash)) || !selector.slice(slash + 1)) throw new Error("mcpTools selectors must be raw server/tool names");
    }
    if (kind === "extensionPaths" && !EXTENSION_FILE.test(selector)) throw new Error("extensionPaths selectors must be explicit JS/TS file paths");
    return selector;
  }))];
}

export function validateResourceSelection(selection: SubagentResourceSelection): SubagentResourceSelection {
  const result: SubagentResourceSelection = {};
  for (const key of ["skillNames", "extensionPaths", "mcpServers", "mcpTools"] as const) {
    const value = validateResourceSelectors(selection[key], key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Boolean aliases have no selector list. Legacy named extension lists never become load-all. */
export function aliasSelectors(value: unknown, kind: "skillNames" | "extensionPaths"): string[] | undefined {
  if (value === undefined || typeof value === "boolean" || (typeof value === "string" && ["true", "false", "all", "none"].includes(value.trim().toLowerCase()))) return undefined;
  const values = typeof value === "string" ? value.split(",").map(s => s.trim()).filter(Boolean) : value;
  if (kind === "extensionPaths" && Array.isArray(values) && values.some(v => typeof v === "string" && !EXTENSION_FILE.test(v))) return [];
  return validateResourceSelectors(values, kind);
}
