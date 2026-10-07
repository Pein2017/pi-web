# Local feature publication qualification — 2026-10-07

## Candidate and ownership

Qualified in `/data/CoordExp/codex-tools/pi-web` on `main`, based on fork
bootstrap `6f94972`, for publication to `Pein2017/pi-web`. This accepts the
existing local Web features and bounded acceptance repairs, not a new Pi Core
implementation, deployment or npm release. Upstream ancestry and license remain
intact; project planning stays in this repository's `openspec/`.

Included feature boundaries:

- Explicit subagent execution choices, resource selection, persisted observations,
  cancellation/turn limits and profile editor round-tripping.
- Managed SDK binding/update adoption and request diagnostics with bounded,
  privacy-aware persisted projections.
- Observed decode TPS and session usage/tree presentation, including demo mirrors.
- Chinese default locale and Full default tool preset; English-specific UI tests
  now select their locale explicitly rather than overriding the product default.
- Standalone test environment isolation, private-directory check exclusions,
  explicit integration targets and CI provisioning of optional SDK peers.

Acceptance repairs preserve the original checks: pending queued workers remain
pending; foreground pre-aborts do not prompt; replace-mode tasks carry the explicit
inheritance choice; editing a profile retains its other fields; TPS-only updates
invalidate the usage memo. Locale/provider, TPS memo and subagent regressions have
RED/GREEN evidence. The socket-failure fixture consumes client bytes before its
intentional disconnect; production proxy behavior was not weakened for the test.

## Completed checks

Runtime: Node **22.22.0**, official Pi SDK **1.0.3**, Next **16.3.6**.
All commands below exited **0** on the qualified local source:

| Check | Result / covered consumer |
| --- | --- |
| `npm test` | **2406/2406** tests, 13 suites, no failures/cancellations/skips; about 13 seconds |
| `node_modules/.bin/tsc --noEmit` | Web source typecheck |
| `npm run lint` | Web source lint, excluding private runtime/recovery and index directories |
| Demo TypeScript and demo-scoped ESLint | Both passed separately; demo exclusion does not stand in for its qualification |
| `npm run test:managed-runtime` | **2/2**; isolated native Next worker adoption and managed binding identity/refusal behavior |
| Explicit compact integration target below | **2/2**; external compact extension to real Web diagnostic listener |
| CI YAML and peer provisioning inspection | Both jobs explicitly install all four official SDK peers at 1.0.3; no local lockfile/install mutation |
| `git diff --check` | Passed |

The external integration target is deliberately not part of standalone `npm test`:

```bash
PI_WEB_COMPACT_SOURCE_ROOT=/data/CoordExp/codex-tools/pi-extensions/packages/pi-codex-compact \
  npm run test:compact-integration
```

Additional retained consumer evidence:

- **139/139** subagent checks, including real SDK/faux-provider spawn, resume and
  persisted-session reopen; resource narrowing and excluded MCP non-start;
  explicit choices, N/N+1 turn bounds, completion notices and cancellation.
- **250/250** locale/UI checks, with production Chinese default unchanged.
- **66/66** diagnostics/runtime checks: loopback request payloads, bounded retention
  and privacy, TPS, warming/retry, compact checkpoint/reload/replay, and native
  worker adoption. Test-owned restart code 77 preserved the CLI process and session
  bytes while updating the SDK/worker generation.
- Read-only checks of the existing service on `127.0.0.1:12345`: `/` and
  `/api/agent/running` returned HTTP **200**. No session mutation was requested.

## Evidence and limits

Raw evidence is private, not committed to GitHub:

- `.local/qualification/fork-publication-20261007/`: `npm-test-final.log`,
  `final.status`, `typecheck-final.log`, `lint-final.log`, `demo-static.status`,
  `managed-runtime-final.log`, `compact-portable-target.log`.
- `.local/tmp/locale-acceptance/`: locale RED/GREEN and scoped lint.
- `/tmp/pi-subagent-acceptance-01a11519/`: scoped RED/GREEN checks and lint/diff.
- `.local/qualification/acceptance-*-01a11519.log`: isolated runtime/diagnostic checks.

Earlier failing/interrupted logs remain as historical evidence; the terminal
`*-final` logs and statuses above establish the repaired candidate's result.
These local checks do **not** establish hosted GitHub CI success, a clean-machine
turnkey installation, every provider/SDK version, real paid-model behavior,
cache performance benefit or actual browser hydration/persistence behavior.
No production restart, active-checkout `next build`, Pi Core change or paid model
call was performed for this publication. The inherited hosted build/e2e workflow
is separate from local acceptance and must be observed independently.

Private runtime installations, profiles, sessions, logs and indexes stay out of
Git. The preexisting Next-generated `AGENTS.md` block is intentionally retained
only in the working copy; authored project guidance is published without it.
The previously discussed inline `$skill` multi-reference feature is **not** part
of this publication.
