# Session usage and cache breakdown

Pi Web keeps its existing lifetime token and cost totals. The totals count every billed usage-bearing entry retained in a session file, across active and abandoned in-session branches and history summarized by compaction. A context edit changes future model context; it does not remove the original billed usage. The top-level token totals, total cost, and lifetime cache-hit rate therefore remain pooled lifetime metrics and do not reset after compaction.

## Categories

The session details panel adds a categorized usage section. Every usage amount belongs to exactly one bucket:

- **Ordinary inference**: usage on assistant messages, including assistant messages on non-active branches.
- **Compaction maintenance**: usage on compaction entries.
- **Branch summary**: usage on branch-summary entries.
- **Cache warming**: `usage` entries whose kind is `cache_warm`.
- **Other / unknown usage**: unknown `usage.kind` values and usage attached to tool-result or other non-assistant messages.

The displayed **Maintenance total** is a presentation-only sum of compaction, branch-summary, and cache-warming buckets. Its detail rows are not extra usage and must not be added to that aggregate a second time. Each row shows its token amount (input + output + cache reads + cache writes) and cost. The unchanged lifetime totals are still shown separately.

Token amounts reconcile exactly by input, output, cache-read, and cache-write fields. The existing chronological lifetime cost remains authoritative; regrouping category costs can change the final floating-point bits, so the category sum is compared with lifetime cost at a documented USD 1e-9 tolerance.

## Cache rates

Cache-hit rates use `cacheRead / (input + cacheRead + cacheWrite)`. Output tokens are excluded, and cache writes remain in the denominator. The panel distinguishes the lifetime pooled rate, ordinary-inference rate, and maintenance rate. If a scope has no input-class tokens (input + cache read + cache write is zero), its rate is **Unavailable**, not 0% or 100%.

## Live updates and reloads

The session API computes categories from all journal entries. The live `get_session_stats` RPC returns the same category breakdown alongside the SDK's existing lifetime totals. The client merges only the authoritative positive lifetime deltas from messages received after load; a reload with no new messages adds nothing. Replaced or removed context never subtracts from retained billed buckets, and cross-category increases cannot add more than the lifetime delta. If multiple growing categories make attribution ambiguous after a decrease, the net increment is temporarily classified as other rather than guessed; journal reload restores exact entry-based classification. Re-reading a session after compaction therefore keeps the all-entry categories and totals without double-counting the active context.

## Frozen arithmetic check

The bounded historical checks read only lines 1–318 of original A (`2026-10-06T16-32-44-654Z_01a1120f-726d-728e-864a-e4f222389428.jsonl`) and lines 1–176 of original B (`2026-10-06T16-11-50-422Z_01a111fc-4f11-728e-864a-e4f0ca7fa36c.jsonl`). No transcript text is part of this record.

| Bounded source | Ordinary inference cache hit | Lifetime pooled cache hit | Lifetime cache reads |
| --- | ---: | ---: | ---: |
| A, lines 1–318 | 90.951866% | 86.986773% | 10,330,624 |
| B, lines 1–176 | 93.787264% | 89.595802% | 5,251,072 |

These are accounting checks for the frozen inputs, not a cache-benefit guarantee or an interpretation of backend cache eligibility.
