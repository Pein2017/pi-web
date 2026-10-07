# Inline skill qualification — 2026-10-07

> Historical first implementation qualification, published in `93cc3c0`.
> The later user review identified a missing acceptance boundary: generated skill
> bodies were appended to the user message and displayed by default. The checks
> below established instruction delivery, not compact user-message behavior.
> The current correction is tracked by tasks 4.1–4.4 of the same OpenSpec change;
> its [accepted correction record](inline-skill-context-qualification.md) supersedes
> the earlier message-presentation claim. These historical results are not rerun evidence for changed
> code.

## Accepted candidate

Lead-accepted local implementation in `/data/CoordExp/codex-tools/pi-web`, based on
`main` at `bdba4e2`. This is working-copy acceptance, not a commit, push, hosted CI
result, deployment or Pi Core change. The active OpenSpec change is
`openspec/changes/inline-multi-skill-mentions/`; usage is in [inline-skills.md](inline-skills.md).

Three inspectable workers used explicit `openai/gpt-6-luna`, `thinking=max`:

- `01a1153c-d65a-725f-be5f-921065891f03`: composer/helper/locales and demo mirrors.
- `01a1153d-29d8-725f-be5f-921310992231`: lexer, bounded loading and Web/SDK integration.
- `01a1153d-70c3-725f-be5f-9214977d2078`: isolated browser acquisition and smoke harness.

The lead reviewed the candidate, repaired remaining harness/fixture issues and
closed the actual terminal-consumer boundary. Worker reports alone did not
establish acceptance.

## Final evidence

Runtime: Node **22.22.0**, official Pi SDK **1.0.3**, Next **16.3.6**,
Playwright **1.63.0**, Chrome Headless Shell **153.0.8010.12** (revision 1243).

| Check | Terminal result |
| --- | --- |
| `npm test` | **2437/2437** passed; 13 suites; zero failures/cancellations/skips; exit 0 |
| Web TypeScript / `npm run lint` | Both exit 0 |
| Separate demo TypeScript / ESLint | Both exit 0 |
| `node e2e/inline-skills.mjs` | PASS, exit 0; four loopback provider requests |
| Strict OpenSpec validation / scoped diff review | Passed |

The browser smoke crossed actual composer → Web API → installed SDK → loopback
OpenAI-compatible fixture → browser reply and persisted transcript readback.
No agent API or SSE route was intercepted. It verified:

- Fresh catalog lazy loading, cursor-local keyboard/pointer completion and
  preserved prefix/suffix/caret without automatic submission.
- Existing `/skill:` and `@` completion, ordinary two-skill input, distinct steer
  and follow-up modes, first-reference order and once-per-message deduplication.
- Literal-only registered skills in code/list fences remain unexpanded; unknown,
  escaped, doubled, currency and embedded-path dollars stay literal.
- User transcript dollar references remain literal rather than becoming paired
  inline math; unchanged raw input reaches the SDK.
- Four fake-provider replies reach the user-visible transcript; no browser errors.

Installed-SDK tests additionally cover actual trust deny/allow/reload/resume and
revocation, explicit-only skills, retained images, registered extension command
arguments, missing-file refusal before provider submission and disabled expansion
for non-Web wrappers. Bounded-loader tests cover regular/UTF-8/file/count/aggregate
refusals, location/baseDir semantics and no recursive generated-body expansion.
The compact quote-to-new-chat composer is covered by caller/handler regression
checks and separate demo static checks, not by the browser smoke.

## Corrections and discriminating checks

- A trust fixture initially disagreed with the wrapper's runtime profile identity.
  It now selects its own profile before SDK/Web imports and uses it consistently;
  no production trust policy was changed or assertion weakened.
- A list-contained fence initially treated code as a reference and hid the live
  reference after the fence. Its concrete regression failed before the shared
  lexer fix, then passed for scanning and caret lookup.
- A static keyboard fixture gained real Escape propagation/dismissal assertions.
- A rendered pair of skill dollars initially became Markdown math. The renderer
  regression failed before a presentation-only fix, then passed while retaining
  raw content and ordinary math.
- Fresh private-copy negative controls bypassing code masks or deduplication each
  fail valid tests with expected exit 1. Active source was never mutated for these
  controls.
- Browser harness corrections preserve actual UI contracts: real caret movement,
  immediate observation of pending waiters, composer-scoped selectors, the slash
  trailing separator and a test-owned Git boundary for ignored host paths.

## Recovery pointers and limits

Private ignored evidence lives under `.local/qualification/inline-skills/`:

- `accepted.status`, `npm-test-accepted.log`, `*-accepted.log`: final full/static checks.
- `browser-final.log` / `.exit`; final run
  `run-2026-10-07T09-50-29.494Z-3241206/`: `evidence.json`, `source-manifest.json`,
  `provider-requests.json`, `web-api-prompt-commands.json`, `next-dev.log`,
  `skill-completion.png`, `terminal.png`.
- `transcript-render-{red,green}.log`, `affected-scope-recheck.log`,
  `lexer-code-mask-negative-final.log`, `expansion-dedup-negative-final.log`.
  The backend worker session listed above retains the original list-fence RED
  command/output; the scoped and full rechecks retain its GREEN result.

Earlier failure logs remain historical, not the final result. The browser run
uses private source/profile/workspace state and the installed dependencies,
adapting only the snapshot's common Next resolver/tracing root. Existing hooks
skip external Google font fetching and optional npm update checking. Thus it
qualifies skill-input behavior, not those unrelated external services, fonts,
all browsers/providers, private Codex APP chip UI or hosted-model quality.

The final browser snapshot was compared with current runtime source, except the
documented fixture-only Next root adaptation. Test-owned Next/browser/provider
processes were stopped; the preexisting managed service was left untouched.
Browser binaries, source snapshots, profiles, sessions and raw logs stay private;
no runtime build/restart, Pi Core edit, paid-model request or publication was
performed for this change.
