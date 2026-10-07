import type { ObservedDecodeTpsSummary } from "../lib/session-decode-tps";
import { buildObservedDecodeTpsPresentation } from "../lib/session-decode-tps-presentation";

interface Props {
  summary: ObservedDecodeTpsSummary | undefined;
  locale: string;
  translate: (key: string) => string;
}

export function SessionDecodeTpsSection({ summary, locale, translate }: Props) {
  const presentation = buildObservedDecodeTpsPresentation(summary, locale, translate);

  return (
    <div style={{ minWidth: 0 }}>
      <section aria-label={translate("session.decodeTpsSection")} style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
          {translate("session.decodeTpsSection")}
        </div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr)",
          columnGap: 12,
          rowGap: 4,
        }}>
          {presentation.rows.map(({ label, value }) => (
            <div key={label} style={{ display: "contents" }}>
              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
              <div style={{
                color: "var(--text-muted)",
                minWidth: 0,
                overflowWrap: "anywhere",
                textAlign: "right",
              }}>{value}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
