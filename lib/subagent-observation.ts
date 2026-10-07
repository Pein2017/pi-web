import { statSync } from "node:fs";
import { openSessionManager } from "./session-reader";
import { computeSessionStats, type SessionFileStats } from "./session-stats";
import { readSubagentTelemetry, SUBAGENT_META_TYPE, SUBAGENT_RESULT_TYPE, SUBAGENT_STATUS_TYPE, type SubagentRunInfo } from "./subagents";
import type { SessionEntry } from "./types";

export interface SubagentObservation {
  scope: "lifecycle-inferred" | "unavailable";
  firstEntryId?: string;
  lastEntryId?: string;
  /** Only a persisted runtime event count is exact; historical responses are not turns. */
  turnCount: number | null;
  turnCountBasis: "turn_end" | null;
  assistantResponses?: number;
  recordedStats?: SessionFileStats;
  responses: Array<{
    entryId: string;
    provider: string;
    selectedModel: string;
    responseModel: string | null;
    thinkingLevel: string | null;
    providerThinkingLevel: string | null;
  }>;
  responsesTruncated: boolean;
  termination: { runtimeStatus: string; modelStopReason: string | null; rawStopReason: string | null; cause: string | null };
  artifacts: Array<{ path: string; kind: "session" | "worktree" | "full-output"; entryId?: string }>;
  artifactsTruncated: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Terminal-only, bounded local IO. Reuse the session reader's fingerprint cache. */
export function readSubagentObservation(run: Pick<SubagentRunInfo, "sessionPath" | "status" | "completedAt" | "worktreePath">): SubagentObservation | undefined {
  if (!run.completedAt || !["completed", "failed", "aborted", "interrupted"].includes(run.status)) return undefined;
  try {
    const file = statSync(run.sessionPath);
    if (!file.isFile() || file.size > 16 * 1024 * 1024) return undefined;
    return projectSubagentObservation(openSessionManager(run.sessionPath).getEntries() as unknown as SessionEntry[], run);
  } catch {
    // Missing or unreadable observation must not change the execution result.
    return undefined;
  }
}

/** Read-time projection of the existing journal, not a new accounting or artifact ledger. */
export function projectSubagentObservation(
  entries: SessionEntry[],
  run: Pick<SubagentRunInfo, "sessionPath" | "status" | "completedAt" | "worktreePath">,
): SubagentObservation {
  const artifacts: SubagentObservation["artifacts"] = [{ path: run.sessionPath, kind: "session" }];
  if (run.worktreePath) artifacts.push({ path: run.worktreePath, kind: "worktree" });
  const observation: SubagentObservation = {
    scope: "unavailable", turnCount: null, turnCountBasis: null, responses: [], responsesTruncated: false,
    termination: { runtimeStatus: run.status, modelStopReason: null, rawStopReason: null, cause: null },
    artifacts, artifactsTruncated: false,
  };
  if (!run.completedAt) return observation;
  const end = entries.findIndex((entry) => entry.type === "custom" && entry.customType === SUBAGENT_RESULT_TYPE
    && record(entry.data)?.completedAt === run.completedAt);
  if (end < 0) return observation;
  const terminal = entries[end];
  const telemetry = terminal.type === "custom" ? readSubagentTelemetry(record(terminal.data)?.telemetry) : undefined;
  if (telemetry) {
    observation.turnCount = telemetry.turnCount;
    observation.turnCountBasis = telemetry.turnCountBasis;
    observation.termination.cause = telemetry.terminationReason;
  }
  let previousResult = -1;
  for (let i = 0; i < end; i++) {
    if (entries[i].type === "custom" && (entries[i] as { customType: string }).customType === SUBAGENT_RESULT_TYPE) previousResult = i;
  }
  let begin = -1;
  for (let i = previousResult + 1; i < end; i++) {
    const entry = entries[i];
    if (entry.type === "custom" && (entry.customType === SUBAGENT_STATUS_TYPE
      || (previousResult < 0 && entry.customType === SUBAGENT_META_TYPE))) { begin = i; break; }
  }
  if (begin < 0) return observation;
  const scoped = entries.slice(begin, end + 1);
  observation.scope = "lifecycle-inferred";
  observation.firstEntryId = scoped[0].id;
  observation.lastEntryId = scoped[scoped.length - 1].id;
  observation.recordedStats = computeSessionStats(scoped);
  observation.assistantResponses = observation.recordedStats.assistantMessages;
  const responseVariants = new Set<string>();
  const artifactPaths = new Set(artifacts.map((artifact) => artifact.path));
  for (const entry of scoped) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      const metadata = message as typeof message & {
        responseModel?: string; thinkingLevel?: string; providerThinkingLevel?: string; rawStopReason?: string;
      };
      const response = {
        entryId: entry.id, provider: message.provider, selectedModel: message.model,
        responseModel: text(metadata.responseModel), thinkingLevel: text(metadata.thinkingLevel),
        providerThinkingLevel: text(metadata.providerThinkingLevel),
      };
      const key = JSON.stringify([response.provider, response.selectedModel, response.responseModel, response.thinkingLevel, response.providerThinkingLevel]);
      if (!responseVariants.has(key)) {
        responseVariants.add(key);
        if (observation.responses.length < 8) observation.responses.push(response);
        else observation.responsesTruncated = true;
      }
      observation.termination.modelStopReason = text(message.stopReason);
      observation.termination.rawStopReason = text(metadata.rawStopReason);
    }
    const fullOutputPath = message.role === "bashExecution" ? text(message.fullOutputPath)
      : message.role === "toolResult" ? text(record(message.details)?.fullOutputPath) : null;
    if (fullOutputPath && !artifactPaths.has(fullOutputPath)) {
      artifactPaths.add(fullOutputPath);
      if (artifacts.length < 16) artifacts.push({ path: fullOutputPath, kind: "full-output", entryId: entry.id });
      else observation.artifactsTruncated = true;
    }
  }
  return observation;
}
