import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Per-invocation decisions, never defaults from a profile, parent, or previous run. */
export interface SubagentExecutionChoices {
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolation: "off" | "worktree";
}

export function validateSubagentExecutionChoices(value: unknown): SubagentExecutionChoices {
  const request = value as Partial<SubagentExecutionChoices> | null;
  if (!request || typeof request !== "object") throw new Error("Agent execution choices are required");
  if (typeof request.model !== "string" || !/^[^/\s]+\/[^\s]+$/.test(request.model)) {
    throw new Error("model is required and must be an explicit provider/modelId");
  }
  if (!SUBAGENT_THINKING_LEVELS.includes(request.thinking as ThinkingLevel)) {
    throw new Error(`thinking is required and must be one of: ${SUBAGENT_THINKING_LEVELS.join(", ")}`);
  }
  if (!Number.isSafeInteger(request.maxTurns) || request.maxTurns! <= 0) {
    throw new Error("max_turns is required and must be a positive safe integer");
  }
  if (typeof request.inheritContext !== "boolean") throw new Error("inherit_context is required and must be a boolean");
  if (typeof request.runInBackground !== "boolean") throw new Error("run_in_background is required and must be a boolean");
  if (request.isolation !== "off" && request.isolation !== "worktree") throw new Error("isolation is required and must be off or worktree");
  return { model: request.model, thinking: request.thinking!, maxTurns: request.maxTurns!, inheritContext: request.inheritContext, runInBackground: request.runInBackground, isolation: request.isolation };
}

/** Validate raw model tool arguments before Pi's TypeBox coercion can change decisions. */
export function validateSubagentToolChoices(value: unknown): SubagentExecutionChoices {
  const args = value as Record<string, unknown> | null;
  return validateSubagentExecutionChoices(args && { model: args.model, thinking: args.thinking, maxTurns: args.max_turns, inheritContext: args.inherit_context, runInBackground: args.run_in_background, isolation: args.isolation });
}

/** Reject unsupported effort before SDK setters (which would otherwise silently clamp it). */
export function resolveSubagentExecutionModel(runtime: Pick<ModelRuntime, "getModel">, choices: SubagentExecutionChoices) {
  const slash = choices.model.indexOf("/");
  const model = runtime.getModel(choices.model.slice(0, slash), choices.model.slice(slash + 1));
  if (!model) throw new Error(`Subagent model not found: ${choices.model}`);
  if (!getSupportedThinkingLevels(model).includes(choices.thinking)) {
    throw new Error(`Subagent thinking ${choices.thinking} is not supported by ${choices.model}; choose a supported thinking level`);
  }
  return model;
}
