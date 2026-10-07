import type { AgentMessage, AgentUsage, SessionEntry, SessionMessage } from "./types";
import { addUsageToBreakdown, emptySessionUsageBreakdown, mergeSessionUsageBreakdown, type SessionUsageBreakdown, type SessionUsageCategory } from "./session-usage-breakdown";
import { computeObservedDecodeTps, type ObservedDecodeTpsSummary } from "./session-decode-tps";

export interface SessionFileStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  usageBreakdown: SessionUsageBreakdown;
  observedDecodeTps?: ObservedDecodeTpsSummary;
}

function emptyStats(): SessionFileStats {
  return {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    usageBreakdown: emptySessionUsageBreakdown(),
  };
}

function addUsage(stats: SessionFileStats, usage: AgentUsage | undefined, category: SessionUsageCategory): void {
  if (!usage) return;
  stats.tokens.input += usage.input ?? 0;
  stats.tokens.output += usage.output ?? 0;
  stats.tokens.cacheRead += usage.cacheRead ?? 0;
  stats.tokens.cacheWrite += usage.cacheWrite ?? 0;
  stats.cost += usage.cost?.total ?? 0;
  addUsageToBreakdown(stats.usageBreakdown, usage, category);
}

function addMessage(stats: SessionFileStats, message: SessionMessage): void {
  // Like the SDK, every message entry counts toward the total, including the
  // transcript system messages that hold the prompt and tool loadout.
  stats.totalMessages += 1;
  if (message.role === "user") {
    stats.userMessages += 1;
  } else if (message.role === "toolResult") {
    stats.toolResults += 1;
  } else if (message.role === "assistant") {
    stats.assistantMessages += 1;
    if (Array.isArray(message.content)) {
      stats.toolCalls += message.content.filter((c) => c.type === "toolCall").length;
    }
  }
  const usage = (message as SessionMessage & { usage?: AgentUsage }).usage;
  addUsage(stats, usage, message.role === "assistant" ? "inference" : "other");
}

function finishStats(stats: SessionFileStats): SessionFileStats {
  stats.tokens.total = stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite;
  return stats;
}

function computeMessageStats(messages: AgentMessage[]): SessionFileStats {
  const stats = emptyStats();
  for (const message of messages) {
    if (message.role === "custom") {
      // Preserve the existing message-count behavior while retaining any billed extension usage.
      addUsage(stats, (message as AgentMessage & { usage?: AgentUsage }).usage, "other");
    } else {
      addMessage(stats, message);
    }
  }
  return finishStats(stats);
}

export function mergeSessionStats(
  fileStats: SessionFileStats | undefined,
  loadedMessages: AgentMessage[],
  currentMessages: AgentMessage[],
): SessionFileStats {
  const current = computeMessageStats(currentMessages);
  if (!fileStats) return current;

  const loaded = computeMessageStats(loadedMessages);
  const delta = (now: number, before: number) => Math.max(0, now - before);
  const tokenDelta = {
    input: delta(current.tokens.input, loaded.tokens.input),
    output: delta(current.tokens.output, loaded.tokens.output),
    cacheRead: delta(current.tokens.cacheRead, loaded.tokens.cacheRead),
    cacheWrite: delta(current.tokens.cacheWrite, loaded.tokens.cacheWrite),
  };
  const costDelta = delta(current.cost, loaded.cost);
  const usageBreakdown = mergeSessionUsageBreakdown(fileStats.usageBreakdown, loaded.usageBreakdown, current.usageBreakdown, {
    tokens: tokenDelta,
    cost: costDelta,
  });
  const tokens = {
    input: fileStats.tokens.input + tokenDelta.input,
    output: fileStats.tokens.output + tokenDelta.output,
    cacheRead: fileStats.tokens.cacheRead + tokenDelta.cacheRead,
    cacheWrite: fileStats.tokens.cacheWrite + tokenDelta.cacheWrite,
    total: 0,
  };
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return {
    userMessages: fileStats.userMessages + delta(current.userMessages, loaded.userMessages),
    assistantMessages: fileStats.assistantMessages + delta(current.assistantMessages, loaded.assistantMessages),
    toolCalls: fileStats.toolCalls + delta(current.toolCalls, loaded.toolCalls),
    toolResults: fileStats.toolResults + delta(current.toolResults, loaded.toolResults),
    totalMessages: fileStats.totalMessages + delta(current.totalMessages, loaded.totalMessages),
    tokens,
    cost: fileStats.cost + costDelta,
    usageBreakdown,
    ...(fileStats.observedDecodeTps ? { observedDecodeTps: fileStats.observedDecodeTps } : {}),
  };
}

/**
 * Aggregate usage across ALL entries in a session file.
 *
 * Mirrors the SDK's `AgentSession.getSessionStats()`: besides assistant
 * (and tool-result) messages, this also counts usage recorded on compaction,
 * branch-summary and `usage` entries (prompt-cache warming, which is billed
 * but never enters model context). Compaction only appends a summary entry — the
 * summarized history stays in the file — so these totals grow monotonically
 * for the life of the session. Totals computed over the active context alone
 * (the compaction-aware message list) shrink whenever old history is
 * summarized away, which is what made the UI token/cost counters appear to be
 * reset after compaction.
 */
export function computeSessionStats(entries: SessionEntry[]): SessionFileStats {
  const stats = emptyStats();

  for (const entry of entries) {
    if (entry.type === "compaction") {
      addUsage(stats, entry.usage, "compaction");
      continue;
    }
    if (entry.type === "branch_summary") {
      addUsage(stats, entry.usage, "branchSummary");
      continue;
    }
    if (entry.type === "usage") {
      addUsage(stats, entry.usage, entry.kind === "cache_warm" ? "cacheWarm" : "other");
      continue;
    }
    if (entry.type !== "message") continue;
    addMessage(stats, entry.message);
  }

  const finished = finishStats(stats);
  const observedDecodeTps = computeObservedDecodeTps(entries);
  return observedDecodeTps ? { ...finished, observedDecodeTps } : finished;
}
