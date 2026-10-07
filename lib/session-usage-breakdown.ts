import type { AgentUsage } from "./types";
import type { ObservedDecodeTpsSummary } from "./session-decode-tps";

export const SESSION_USAGE_CATEGORIES = [
  "inference",
  "compaction",
  "branchSummary",
  "cacheWarm",
  "other",
] as const;

export type SessionUsageCategory = (typeof SESSION_USAGE_CATEGORIES)[number];

export interface SessionUsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionUsageBucket {
  tokens: SessionUsageTokens;
  cost: number;
}

export type SessionUsageBreakdown = Record<SessionUsageCategory, SessionUsageBucket>;

export interface SessionUsageDelta {
  tokens: Pick<SessionUsageTokens, "input" | "output" | "cacheRead" | "cacheWrite">;
  cost: number;
}

export interface SessionUsageDisplayStats {
  usageBreakdown: SessionUsageBreakdown;
  tokens: SessionUsageTokens;
  cost: number;
}

export interface SessionUsageRow {
  key: string;
  label: string;
  value: string;
}

function emptyBucket(): SessionUsageBucket {
  return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
}

export function emptySessionUsageBreakdown(): SessionUsageBreakdown {
  return {
    inference: emptyBucket(),
    compaction: emptyBucket(),
    branchSummary: emptyBucket(),
    cacheWarm: emptyBucket(),
    other: emptyBucket(),
  };
}

export function addUsageToBreakdown(
  breakdown: SessionUsageBreakdown,
  usage: AgentUsage | undefined,
  category: SessionUsageCategory,
): void {
  if (!usage) return;
  const bucket = breakdown[category];
  bucket.tokens.input += usage.input ?? 0;
  bucket.tokens.output += usage.output ?? 0;
  bucket.tokens.cacheRead += usage.cacheRead ?? 0;
  bucket.tokens.cacheWrite += usage.cacheWrite ?? 0;
  bucket.tokens.total = bucket.tokens.input + bucket.tokens.output + bucket.tokens.cacheRead + bucket.tokens.cacheWrite;
  bucket.cost += usage.cost?.total ?? 0;
}

/**
 * Allocate only the authoritative positive live-message delta. Never subtract replaced context from the
 * lifetime buckets; if category decreases cancel or obscure increases, preserve the baseline and attribute
 * only a unique positive class, otherwise put the net amount in `other` rather than guessing.
 * Category costs can regroup floating-point additions, so lifetime chronological cost stays authoritative
 * and the final bucket sum is reconciled within USD 1e-9.
 */
export function mergeSessionUsageBreakdown(
  file: SessionUsageBreakdown,
  loaded: SessionUsageBreakdown,
  current: SessionUsageBreakdown,
  totalDelta: SessionUsageDelta,
): SessionUsageBreakdown {
  const merged = emptySessionUsageBreakdown();
  for (const category of SESSION_USAGE_CATEGORIES) {
    const destination = merged[category];
    const base = file[category];
    destination.tokens.input = base.tokens.input;
    destination.tokens.output = base.tokens.output;
    destination.tokens.cacheRead = base.tokens.cacheRead;
    destination.tokens.cacheWrite = base.tokens.cacheWrite;
    destination.cost = base.cost;
  }

  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const categoryChanges = SESSION_USAGE_CATEGORIES.map((category) => ({
      category,
      amount: current[category].tokens[field] - loaded[category].tokens[field],
    }));
    for (const { category, amount } of allocateNetDelta(totalDelta.tokens[field], categoryChanges)) {
      merged[category].tokens[field] += amount;
    }
  }

  const costChanges = SESSION_USAGE_CATEGORIES.map((category) => ({
    category,
    amount: current[category].cost - loaded[category].cost,
  }));
  for (const { category, amount } of allocateNetDelta(totalDelta.cost, costChanges)) {
    merged[category].cost += amount;
  }

  for (const category of SESSION_USAGE_CATEGORIES) {
    const bucket = merged[category];
    bucket.tokens.total = bucket.tokens.input + bucket.tokens.output + bucket.tokens.cacheRead + bucket.tokens.cacheWrite;
  }
  return merged;
}

function allocateNetDelta(
  totalDelta: number,
  changes: Array<{ category: SessionUsageCategory; amount: number }>,
): Array<{ category: SessionUsageCategory; amount: number }> {
  if (totalDelta <= 0) return [];

  const increases = changes.filter(({ amount }) => amount > 0);
  const hasDecrease = changes.some(({ amount }) => amount < 0);
  if (!hasDecrease && increases.length > 1) return increases;
  if (increases.length === 1) return [{ category: increases[0].category, amount: totalDelta }];
  return [{ category: "other", amount: totalDelta }];
}

function sumBuckets(...buckets: SessionUsageBucket[]): SessionUsageBucket {
  const result = emptyBucket();
  for (const bucket of buckets) {
    result.tokens.input += bucket.tokens.input;
    result.tokens.output += bucket.tokens.output;
    result.tokens.cacheRead += bucket.tokens.cacheRead;
    result.tokens.cacheWrite += bucket.tokens.cacheWrite;
    result.cost += bucket.cost;
  }
  result.tokens.total = result.tokens.input + result.tokens.output + result.tokens.cacheRead + result.tokens.cacheWrite;
  return result;
}

/** The cache denominator covers input-class tokens and deliberately excludes output. */
export function cacheUsageFraction(bucket: Pick<SessionUsageBucket, "tokens"> | Pick<SessionUsageDisplayStats, "tokens">): number | null {
  const { input, cacheRead, cacheWrite } = bucket.tokens;
  const denominator = input + cacheRead + cacheWrite;
  return denominator > 0 ? cacheRead / denominator : null;
}

function formatCacheRate(fraction: number | null, translate: (key: string) => string): string {
  return fraction === null ? translate("session.usage.unavailable") : `${(fraction * 100).toFixed(1)}%`;
}

export function buildSessionUsageBreakdownRows(
  breakdown: SessionUsageBreakdown,
  translate: (key: string) => string,
  locale: string,
): SessionUsageRow[] {
  const maintenance = sumBuckets(breakdown.compaction, breakdown.branchSummary, breakdown.cacheWarm);
  const rows = [
    { key: "inference", labelKey: "session.usage.inference", bucket: breakdown.inference },
    { key: "maintenance", labelKey: "session.usage.maintenance", bucket: maintenance },
    { key: "compaction", labelKey: "session.usage.compaction", bucket: breakdown.compaction },
    { key: "branchSummary", labelKey: "session.usage.branchSummary", bucket: breakdown.branchSummary },
    { key: "cacheWarm", labelKey: "session.usage.cacheWarm", bucket: breakdown.cacheWarm },
    { key: "other", labelKey: "session.usage.other", bucket: breakdown.other },
  ];
  return rows.map(({ key, labelKey, bucket }) => ({
    key,
    label: translate(labelKey),
    value: `${bucket.tokens.total.toLocaleString(locale)} ${translate("session.usage.tokens")} · $${bucket.cost.toFixed(4)}`,
  }));
}

export function buildSessionCacheRateRows(
  stats: SessionUsageDisplayStats,
  translate: (key: string) => string,
): SessionUsageRow[] {
  const maintenance = sumBuckets(stats.usageBreakdown.compaction, stats.usageBreakdown.branchSummary, stats.usageBreakdown.cacheWarm);
  return [
    { key: "lifetime", labelKey: "session.cacheHitRate", bucket: { tokens: stats.tokens } },
    { key: "ordinary", labelKey: "session.usage.ordinaryCacheHitRate", bucket: stats.usageBreakdown.inference },
    { key: "maintenance", labelKey: "session.usage.maintenanceCacheHitRate", bucket: maintenance },
  ].map(({ key, labelKey, bucket }) => ({
    key,
    label: translate(labelKey),
    value: formatCacheRate(cacheUsageFraction(bucket), translate),
  }));
}

export interface SessionStatsMemoInput extends SessionUsageDisplayStats {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  totalActiveMs?: number;
  observedDecodeTps?: ObservedDecodeTpsSummary;
}

export function sessionStatsMemoKey(stats: SessionStatsMemoInput): string {
  const breakdown = SESSION_USAGE_CATEGORIES.flatMap((category) => {
    const bucket = stats.usageBreakdown[category];
    return [category, bucket.tokens.input, bucket.tokens.output, bucket.tokens.cacheRead, bucket.tokens.cacheWrite, bucket.tokens.total, bucket.cost];
  });
  return JSON.stringify([
    stats.sessionId,
    stats.sessionFile ?? "",
    stats.sessionName ?? "",
    stats.userMessages,
    stats.assistantMessages,
    stats.toolCalls,
    stats.toolResults,
    stats.totalMessages,
    stats.tokens.input,
    stats.tokens.output,
    stats.tokens.cacheRead,
    stats.tokens.cacheWrite,
    stats.tokens.total,
    stats.cost,
    stats.totalActiveMs ?? 0,
    ...breakdown,
    stats.observedDecodeTps ?? null,
  ]);
}
