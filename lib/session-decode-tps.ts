import { OBSERVED_DECODE_TPS_ENTRY_TYPE } from "./session-decode-tps-constants.js";
import type { SessionEntry } from "./types";

export { OBSERVED_DECODE_TPS_ENTRY_TYPE } from "./session-decode-tps-constants.js";

export type ObservedDecodeTpsExclusionReason =
  | "not-streamed"
  | "insufficient-deltas"
  | "missing-output-usage"
  | "invalid-duration"
  | "interrupted";

export interface ObservedDecodeTpsRecord {
  version: 1;
  assistantEntryId: string;
  provider: string;
  modelId: string;
  status: "measured" | "excluded";
  outputDeltaCount: number;
  outputTokens?: number;
  elapsedMs?: number;
  exclusionReason?: ObservedDecodeTpsExclusionReason;
}

export interface ObservedDecodeTpsRate {
  /** Null when no response in this aggregate has a valid rate. */
  tps: number | null;
  outputTokens: number;
  elapsedMs: number;
  measuredResponses: number;
  trackedResponses: number;
}

export interface ObservedDecodeTpsGroup extends ObservedDecodeTpsRate {
  provider: string;
  modelId: string;
}

export interface ObservedDecodeTpsSummary extends ObservedDecodeTpsRate {
  groups: ObservedDecodeTpsGroup[];
}

interface PendingAssistantResponse {
  message: object;
  outputDeltaCount: number;
  firstDeltaMs?: number;
  lastDeltaMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): ObservedDecodeTpsRecord | null {
  if (!isObject(value) || value.version !== 1) return null;
  if (
    typeof value.assistantEntryId !== "string" || value.assistantEntryId.length === 0
    || typeof value.provider !== "string" || value.provider.length === 0
    || typeof value.modelId !== "string" || value.modelId.length === 0
    || (value.status !== "measured" && value.status !== "excluded")
    || !Number.isInteger(value.outputDeltaCount) || (value.outputDeltaCount as number) < 0
  ) return null;

  if (value.status === "measured") {
    if (
      typeof value.outputTokens !== "number" || !Number.isFinite(value.outputTokens) || value.outputTokens <= 0
      || typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs <= 0
      || (value.outputDeltaCount as number) < 2
    ) return null;
  } else if (
    typeof value.exclusionReason !== "string" || value.exclusionReason.length === 0
  ) {
    return null;
  }

  return value as unknown as ObservedDecodeTpsRecord;
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> {
  return isObject(value) && value.role === "assistant";
}

function isNonEmptyOutputDelta(value: unknown): boolean {
  if (!isObject(value) || typeof value.type !== "string") return false;
  return (
    (value.type === "text_delta" || value.type === "thinking_delta" || value.type === "toolcall_delta")
    && typeof value.delta === "string"
    && value.delta.length > 0
  );
}

/**
 * Captures the server-side first-to-last output delta interval for each assistant
 * message. The clock is injected so tests can make the event/timing contract
 * deterministic; production passes a monotonic process clock.
 */
export class ObservedDecodeTpsEventTracker {
  private activeResponse?: PendingAssistantResponse;
  private ambiguousLifecycle = false;
  private completed: PendingAssistantResponse[] = [];
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  observe(event: unknown): void {
    if (!isObject(event) || typeof event.type !== "string" || !isAssistantMessage(event.message)) return;
    const message = event.message;

    if (event.type === "message_start") {
      // The SDK streams one assistant response at a time, but emits fresh
      // message copies at start/update. References identify only final entries.
      // Overlapping starts violate that boundary: discard timing until drain.
      if (this.activeResponse) {
        this.activeResponse = undefined;
        this.ambiguousLifecycle = true;
      } else if (!this.ambiguousLifecycle) {
        this.activeResponse = { message, outputDeltaCount: 0 };
      }
      return;
    }

    if (this.ambiguousLifecycle || !this.activeResponse) return;

    if (event.type === "message_update" && isNonEmptyOutputDelta(event.assistantMessageEvent)) {
      const response = this.activeResponse;
      const timestamp = this.now();
      response.firstDeltaMs ??= timestamp;
      response.lastDeltaMs = timestamp;
      response.outputDeltaCount += 1;
      return;
    }

    if (event.type === "message_end") {
      const response = this.activeResponse;
      response.message = message;
      this.activeResponse = undefined;
      this.completed.push(response);
    }
  }

  /** Resolve only completed messages with one exact persisted assistant entry. */
  drain(entries: readonly SessionEntry[]): ObservedDecodeTpsRecord[] {
    const completed = this.completed;
    this.completed = [];
    this.activeResponse = undefined;
    this.ambiguousLifecycle = false;

    const entryIdsByMessage = new Map<object, string[]>();
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const message = entry.message as object;
      const entryIds = entryIdsByMessage.get(message) ?? [];
      entryIds.push(entry.id);
      entryIdsByMessage.set(message, entryIds);
    }

    const completionCounts = new Map<object, number>();
    for (const response of completed) {
      completionCounts.set(response.message, (completionCounts.get(response.message) ?? 0) + 1);
    }
    const records: ObservedDecodeTpsRecord[] = [];
    for (const response of completed) {
      const entryIds = entryIdsByMessage.get(response.message);
      if (!entryIds || entryIds.length !== 1 || completionCounts.get(response.message) !== 1) continue;

      const message = response.message as Record<string, unknown>;
      const provider = message.provider;
      const modelId = message.model;
      if (typeof provider !== "string" || provider.length === 0 || typeof modelId !== "string" || modelId.length === 0) continue;

      const usage = isObject(message.usage) ? message.usage : undefined;
      const outputTokens = usage?.output;
      const elapsedMs = response.firstDeltaMs === undefined || response.lastDeltaMs === undefined
        ? undefined
        : response.lastDeltaMs - response.firstDeltaMs;
      const base = {
        version: 1 as const,
        assistantEntryId: entryIds[0],
        provider,
        modelId,
        outputDeltaCount: response.outputDeltaCount,
      };

      if (message.stopReason === "aborted" || message.stopReason === "error") {
        records.push({ ...base, status: "excluded", exclusionReason: "interrupted" });
      } else if (response.outputDeltaCount === 0) {
        records.push({ ...base, status: "excluded", exclusionReason: "not-streamed" });
      } else if (response.outputDeltaCount < 2) {
        records.push({ ...base, status: "excluded", exclusionReason: "insufficient-deltas" });
      } else if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens <= 0) {
        records.push({ ...base, status: "excluded", exclusionReason: "missing-output-usage" });
      } else if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
        records.push({ ...base, status: "excluded", exclusionReason: "invalid-duration" });
      } else {
        records.push({ ...base, status: "measured", outputTokens, elapsedMs });
      }
    }
    return records;
  }
}

function rate(
  outputTokens: number,
  elapsedMs: number,
  measuredResponses: number,
  trackedResponses: number,
): ObservedDecodeTpsRate {
  return {
    tps: measuredResponses > 0 && elapsedMs > 0 ? outputTokens / (elapsedMs / 1000) : null,
    outputTokens,
    elapsedMs,
    measuredResponses,
    trackedResponses,
  };
}

/**
 * Rebuild host-observed response rates from Pi Web's versioned session entries.
 * Records are accepted only when they point to a real assistant message; legacy
 * sessions and malformed/unsupported records are left unmeasured.
 */
export function computeObservedDecodeTps(
  entries: readonly SessionEntry[],
): ObservedDecodeTpsSummary | undefined {
  const assistantEntryIds = new Set(
    entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .map((entry) => entry.id),
  );
  const seenAssistantEntryIds = new Set<string>();
  const accumulators = new Map<string, {
    provider: string;
    modelId: string;
    outputTokens: number;
    elapsedMs: number;
    measuredResponses: number;
    trackedResponses: number;
  }>();

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== OBSERVED_DECODE_TPS_ENTRY_TYPE) continue;
    const record = parseRecord(entry.data);
    if (!record || !assistantEntryIds.has(record.assistantEntryId) || seenAssistantEntryIds.has(record.assistantEntryId)) continue;

    seenAssistantEntryIds.add(record.assistantEntryId);
    const groupKey = JSON.stringify([record.provider, record.modelId]);
    let group = accumulators.get(groupKey);
    if (!group) {
      group = {
        provider: record.provider,
        modelId: record.modelId,
        outputTokens: 0,
        elapsedMs: 0,
        measuredResponses: 0,
        trackedResponses: 0,
      };
      accumulators.set(groupKey, group);
    }
    group.trackedResponses += 1;
    if (record.status === "measured") {
      group.outputTokens += record.outputTokens!;
      group.elapsedMs += record.elapsedMs!;
      group.measuredResponses += 1;
    }
  }

  if (accumulators.size === 0) return undefined;

  const groups = [...accumulators.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId))
    .map((group) => ({
      provider: group.provider,
      modelId: group.modelId,
      ...rate(group.outputTokens, group.elapsedMs, group.measuredResponses, group.trackedResponses),
    }));
  const outputTokens = groups.reduce((sum, group) => sum + group.outputTokens, 0);
  const elapsedMs = groups.reduce((sum, group) => sum + group.elapsedMs, 0);
  const measuredResponses = groups.reduce((sum, group) => sum + group.measuredResponses, 0);
  const trackedResponses = groups.reduce((sum, group) => sum + group.trackedResponses, 0);

  return {
    ...rate(outputTokens, elapsedMs, measuredResponses, trackedResponses),
    groups,
  };
}
