# Compact inline skill context qualification — 2026-10-07

## Accepted boundary

Lead-accepted local correction in `/data/CoordExp/codex-tools/pi-web`, `main`
based on `93cc3c0`. This is uncommitted working-copy acceptance, not publication,
hosted CI, production adoption or a Pi Core modification. It supersedes the
compact-message claim missing from the [first qualification](inline-skills-qualification.md).
The same local OpenSpec change, `inline-multi-skill-mentions`, owns correction
tasks 4.1–4.4. Usage and portability are in [inline-skills.md](inline-skills.md).

Three inspectable workers used explicit `openai/gpt-6-luna`, `thinking=max`:

- `01a116b1-c25c-725f-be5f-9233f98d8cd0`: backend and installed-SDK lifecycle tests.
- `01a116b2-15d9-725f-be5f-9235953058e6`: compact presentation, legacy parser and demo mirrors.
- `01a116b2-5c69-725f-be5f-9237935ab963`: independent real-browser smoke and baseline RED.

The lead reviewed the representation and final consumer evidence, added the
optimistic-delivery correction, and required a queued nested-extension RED/GREEN
repair before acceptance. Worker reports alone did not establish acceptance.

## Representation

User-authored `message.content` stays short and unchanged. Registered identities
and bounded, frontmatter-stripped instruction snapshots live outside that text
in `message.piWeb.inlineSkillContext = {version:1, requestId, skills}`. Each skill
contains `name`, `filePath`, `baseDir` and `body`. A Web-owned public `Agent`
method adapter binds this metadata to the actual SDK user object. The SDK's
public `context` hook projects one separate instruction message immediately after
its originating user message; private metadata and request IDs are stripped
from provider input. This is not a second independently queued context send.

Public pre-compaction and pre-tree hooks expose snapshots to the SDK summarizers.
Reopen and persisted forks retain the original snapshot rather than rereading
changed skill files. Compacted/discarded or abandoned messages follow the SDK's
normal context selection; the adapter does not resurrect their snapshots.

The UI shows short text and skill chips. Paths and complete instructions require
explicit disclosure. Copy/edit uses the original request, retaining images and
removing old inline-skill metadata from the editable copy. Complete legacy
appended envelopes receive strict display-only restoration; no history file is
rewritten. Malformed, code-quoted, unmentioned or ambiguous lookalikes remain text.

## Final checks

Runtime: Node **22.22.0**, official Pi SDK **1.0.3**, Next **16.3.6**,
Playwright **1.63.0**, Chrome Headless Shell **153.0.8010.12** (revision 1243).

| Check | Result |
| --- | --- |
| `npm test` | **2459/2459** passed, 13 suites, no failures/cancellations/skips, exit 0 |
| Web TypeScript / ESLint | Both exit 0; no lint warnings |
| Separate demo TypeScript / ESLint | Both exit 0 |
| `node e2e/inline-skills.mjs` | PASS, exit 0; four real loopback provider requests |
| Strict OpenSpec validation / `git diff --check` | Passed |

The final browser run is
`.local/qualification/inline-skill-context/run-2026-10-07T15-42-08.374Z-3620769/`.
It crossed actual browser composer → Web API → installed SDK → loopback
OpenAI-compatible provider → browser reply, persisted JSONL and refresh.
No agent API or SSE interception was used. It verified:

- Exact original text for all four API commands and persisted user messages,
  with separately retained V1 snapshots and registered identities.
- Immediate independent provider-context grouping: main `beta`, steer
  `alpha,beta`, follow-up `beta,alpha`, ordinary multi-reference `beta,alpha`.
  Repeated names deduplicate within their originating request; future queued
  requests do not appear in the initial provider input.
- Compact default presentation, opt-in paths/bodies, compact refresh,
  actual clipboard text and edit prefill without generated bodies.
- Legacy history disclosure, retained slash and `@` completion, dollar literals,
  code/list fences and unrelated math.
- A valid screenshot-generated **96×64 PNG**, **2689 bytes**, through the actual
  composer attachment, API, SDK, provider payload, persistence, refresh and edit.
- Zero browser errors/provider failures. Test-owned Next exit 0 and process-group
  cleanup confirmed.

The final source binding records 430 copied files, 3,828,998 bytes and snapshot
SHA-256 `721c4810c51b71c6dd1238cb345a841639bd87e9fd2e16e2e6afde771c675fa5`.
All 429 files other than the documented fixture-only `next.config.ts` root
adaptation matched the working tree; the E2E script also matched. The lead read
`evidence.json`, `source-binding.json`, and the compact/expanded screenshots.

Installed-SDK tests additionally qualify identical-text queue association with
changed snapshots, queue clearing, extension-handled input and nested extension
sends in prompt/direct-steer/direct-follow-up/streaming-prompt paths, refused
missing files or unavailable Agent boundaries, trust/reload/resume, images,
retained slash/extension commands, non-Web defaults, persisted fork/reopen V1,
summary inputs and no discarded/abandoned snapshot resurrection. SDK wrappers
are restored on disposal and rebound after reload.

## Discriminating failures and repairs

- Baseline `93cc3c0` failed the new browser raw-provider-message assertion with
  expected exit 1: it appended instructions to the ordinary user message. Its
  API command was short, so API-only evidence would have missed the defect.
- The first candidate browser failure exposed the optimistic UI path discarding
  authoritative metadata when delivered text equaled the optimistic copy.
  A regression executing the real state-updater callback failed before the fix,
  then passed for root/demo while preserving separate later identical-text
  deliveries. The UI now replaces the adjacent optimistic bubble with the
  authoritative delivered object rather than keeping the metadata-free copy.
- Lead review found that direct queued inputs could let a nested
  `source: "extension"` prompt claim a Web reservation. The actual SDK regression
  reproduced this before the guard and passed afterward for all three queued
  entry modes. No text-based request join or detached context queue was added.
- Four initial full-suite failures were stale source-shape assertions for renamed
  preflight/reload helpers and the added chat-only history projector. Their
  original trust, exact-prompt and reload-delegation invariants were retained;
  the final full suite passed.
- A direct scoped trust run inherited the dev launcher's `TMPDIR` and therefore
  discovered host ancestor skills in supposedly empty fixtures. Running with
  the established standalone test environment passed **70/70** hook/trust checks;
  no production trust policy was weakened.
- Harness-only failures involved an invalid tiny PNG, locale-specific selectors,
  an image-preview/disclosure selector collision, and DOM whitespace assumptions.
  The final harness uses a real PNG, explicit isolated English locale, scoped
  controls and full-content comparisons insensitive only to rendered whitespace.
  Earlier failure receipts are retained, not represented as final success.

## Evidence and limits

Private ignored evidence is under `.local/qualification/inline-skill-context/`:
`npm-test-final.log/.exit`, `typecheck-final.*`, `lint-final.*`,
`demo-typecheck-final.*`, `demo-lint-final.*`, `openspec-strict.*`,
`optimistic-metadata-red.*`, `lead-hook-trust-standalone-green.*`, and the final
run's `evidence.json`, `source-manifest.json`, `source-binding.json`,
`provider-requests.json`, `web-api-prompt-commands.json`, JSONL, Next log and PNGs.
The accepted baseline RED is `run-2026-10-07T14-57-14.367Z-3558291/`.
Backend scratch/scoped evidence and the inspectable worker session retain the
SDK boundary, nested-extension RED/GREEN and summary checks.

This is technical input/lifecycle qualification with a fake provider, not proof
of hosted-model quality or all providers/browsers. Compact display does not
reduce model tokens: full instructions still enter context. Deduplication is
per originating message, not cross-turn caching. Summary retention still obeys
SDK token budgets; older branch entries can be omitted by those budgets.

The metadata adapter uses public methods plus public extension events, not a
Core patch or a new documented SDK metadata hook. Native Pi CLI does not install
the Web projector, so native-CLI snapshot replay is not qualified. The original
managed Next process (PID 2924369, port 12345) was not restarted; active service
adoption is separate from the isolated source smoke. No paid model, Core source
change, commit, push, OpenSpec archive or runtime deployment was performed.
