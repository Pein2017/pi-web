import type { ObservedDecodeTpsSummary } from "./session-decode-tps";

export interface SessionDecodeTpsPresentation {
  rows: Array<{ label: string; value: string }>;
}

/** Formats host-observed TPS and coverage for the session-details panel. */
export function buildObservedDecodeTpsPresentation(
  summary: ObservedDecodeTpsSummary | undefined,
  locale: string,
  translate: (key: string) => string,
): SessionDecodeTpsPresentation {
  const formatRate = (tps: number | null | undefined) =>
    typeof tps === "number" && Number.isFinite(tps) && tps > 0
      ? `${tps.toFixed(1)} t/s`
      : translate("session.decodeTpsUnavailable");
  const groups = [...(summary?.groups ?? [])]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
  const rows = [
    {
      label: translate("session.decodeTps"),
      value: formatRate(summary?.tps),
    },
    {
      label: translate("session.decodeTpsCoverage"),
      value: `${(summary?.measuredResponses ?? 0).toLocaleString(locale)} / ${(summary?.trackedResponses ?? 0).toLocaleString(locale)}`,
    },
    ...(groups.length > 1
      ? [{
          label: translate("session.decodeTpsBreakdown"),
          value: groups.map((group) => `${group.provider}/${group.modelId}: ${formatRate(group.tps)}`).join(" · "),
        }]
      : []),
  ];

  return { rows };
}
