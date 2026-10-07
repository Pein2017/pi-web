import { resolve } from "node:path";
import {
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { isMcpDisabledByOperator } from "./builtin-extensions";
import { loadPiSdkInternals } from "./pi-sdk-internals";
import { createPiWebMcpTransportFactory } from "./mcp-transport";
import { mayReadProjectConfigNow } from "./project-trust";
import { validateResourceSelection, type SubagentResourceSelection } from "./subagent-resource-selection";
import { SUBAGENT_CONTROL_TOOL_NAMES } from "./subagents";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type Resources = SubagentResourceSelection & { loadSkills: boolean; loadExtensions: boolean };
const CODING_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/** Shared spawn/reopen boundary: selectors narrow the SDK loader, not just startup display. */
export async function subagentResourceLoaderOptions(
  resources: Resources,
  cwd: string,
  agentDir: string,
): Promise<Pick<DefaultResourceLoaderOptions, "noExtensions" | "noSkills" | "additionalExtensionPaths" | "skillsOverride" | "extensionFactories">> {
  const selection = validateResourceSelection(resources);
  const factories: InlineExtension[] = [];
  if (selection.mcpServers?.length) {
    if (isMcpDisabledByOperator()) throw new Error("Subagent MCP is disabled by PI_WEB_DISABLE_MCP");
    const internals = await loadPiSdkInternals();
    if (!internals.ok) throw new Error(`Subagent MCP unavailable: ${internals.reason}`);
    const servers = new Set(selection.mcpServers);
    const tools = selection.mcpTools === undefined ? undefined : new Set(selection.mcpTools);
    const transport = createPiWebMcpTransportFactory(internals);
    const mcp = createMcpExtension({
      loadConfig: ctx => {
        const loaded = internals.loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: mayReadProjectConfigNow(ctx.cwd, agentDir) });
        return {
          errors: [], autoEnableCodemode: false,
          servers: loaded.servers.filter(entry => servers.has(entry.name) && entry.config.enabled !== false).map(entry => {
            const toolExposure: Record<string, "hidden" | "deferred"> = Object.create(null);
            if (tools) {
              for (const selector of tools) {
                const prefix = `${entry.name}/`;
                if (!selector.startsWith(prefix)) continue;
                const name = selector.slice(prefix.length);
                if (internals.getMcpToolExposure(entry.config, name) !== "hidden") toolExposure[name] = "deferred";
              }
            } else {
              for (const [name, exposure] of Object.entries(entry.config.toolExposure ?? {})) toolExposure[name] = exposure === "hidden" ? "hidden" : "deferred";
            }
            return { ...entry, config: { ...entry.config, exposure: tools ? "hidden" as const : entry.config.exposure === "hidden" ? "hidden" as const : "deferred" as const, toolExposure } };
          }),
        };
      },
      // No fallback to an unscrubbed transport, including extension registrations.
      createTransport: (entry, childCwd, auth) => {
        if (!servers.has(entry.name)) throw new Error("MCP server is outside the subagent resource selection");
        return transport(entry, childCwd, auth);
      },
      startupWaitMs: 0, openUrl: () => {},
      updateConfig: () => { throw new Error("Subagent MCP selection is fixed; edit the profile for a new child"); },
    });
    factories.push({ name: "pi-web-subagent-mcp", factory: pi => mcp({ ...pi, registerCommand: (name, command) => { if (name !== "mcp") pi.registerCommand(name, command); } }) });
    factories.push({ name: "pi-web-subagent-tool-search", factory: createToolSearchExtension() });
  }
  const selectedSkills = selection.skillNames === undefined ? undefined : new Set(selection.skillNames);
  return {
    noExtensions: !resources.loadExtensions || selection.extensionPaths !== undefined,
    noSkills: !resources.loadSkills || selectedSkills?.size === 0,
    ...(resources.loadExtensions && selection.extensionPaths !== undefined ? { additionalExtensionPaths: selection.extensionPaths.map(path => resolve(cwd, path)) } : {}),
    ...(selectedSkills ? { skillsOverride: base => ({ ...base, skills: base.skills.filter(skill => selectedSkills.has(skill.name)) }) } : {}),
    extensionFactories: factories,
  };
}

/** MCP names arrive asynchronously. A static SDK allow-list would discard them forever. */
export function subagentSessionToolOptions(
  resources: SubagentResourceSelection & { tools: string[] },
  extensions: LoadExtensionsResult,
): { tools?: string[]; excludeTools: string[] } {
  if (!resources.mcpServers?.length) return { tools: resources.tools, excludeTools: [...SUBAGENT_CONTROL_TOOL_NAMES] };
  const allowed = new Set([...resources.tools, "tool_search"]);
  return {
    excludeTools: [...new Set([
      ...SUBAGENT_CONTROL_TOOL_NAMES,
      ...MCP_RESOURCE_TOOLS,
      ...CODING_TOOLS.filter(name => !allowed.has(name)),
      ...extensions.extensions.flatMap(extension => [...extension.tools.keys()]).filter(name => !allowed.has(name)),
    ])],
  };
}
