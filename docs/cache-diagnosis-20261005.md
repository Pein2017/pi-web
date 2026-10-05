# Pi cache and continuation diagnosis, 2026-10-05

## Scope and runtime

The user authorized one shared Pi profile, bounded cache diagnostics, fixes and
Web restarts. Pi Web and terminal Pi select `/data/CoordExp/.pi`. This diagnostic
used Web SDK 1.0.0 and terminal Pi's managed release 1.0.3. Official
OpenAI automatic and explicit backend compaction remain required capabilities.
No Git publication is part of this change.

A subsequent installation change made Web and terminal share the managed 1.0.3
release; see [shared Pi runtime](shared-pi-runtime.md). The measurements below
retain their original SDK scope and were not repeated for that later change.

Recovery material for profile consolidation is under
`.local/recovery/pi-shared-root-20261005/`. Isolated provider diagnostics and
content-free request receipts belong to `.local/diagnostics/cache-20261005/`.
Production transcripts, canonical memory records and credential values are not
diagnostic output. The live model-request budget is at most twelve calls; no
automatic retry, cache warming or tool execution is permitted in those probes.

## Historical observation and inference boundary

The five selected Pi Web sessions previously inspected had 2,858,496 cached
input tokens and 13,543,423 uncached input tokens: pooled cache fraction 17.43%.
Pi normalized `input` excludes `cacheRead`, so the denominator is
`input + cacheRead`, rather than `input` alone. This is a dated descriptive
sample, not a paired causal comparison or a claim about all Pi sessions.
Extension-disabled children with high late-turn reuse differ in history and
extension behavior; they motivate investigation but do not identify a cause.

## Concrete source defects

1. The original shared-memory Pi context hook removes its owned recalled
   snapshot and appends it at the conversation tail on every request. An
   unchanged snapshot consequently moves when conversation grows. This breaks
   the prior complete message prefix. It does not by itself prove a particular
   loss of backend cached tokens.
2. The original server-compaction SSE fallback checks and trims a previous
   response reference before invoking extension payload hooks. The plugin hook
   then adds that reference to the still-complete history. Recording transport
   reproduced a previous ID plus full replay. Raw branch message counts also
   do not represent converted provider items after context editing, custom
   recall injection, reasoning or tool expansion.
3. Replacing the entire provider input with stored opaque compaction history
   discards currently selected native system input and ephemeral recall.
   Retained-caller checks must preserve these alongside the opaque artifact.

## Harness comparison

The shared-memory Codex adapter translates native `SessionStart` startup,
resume, clear and compact events into appended `additionalContext`. It does not
reposition the snapshot during every ordinary request. The Pi adapter runs a
context hook per request and replaces its own ephemeral snapshot. These are
verified adapter differences, not an audit of every internal Codex cache path.
Codex can retain older hook snapshots in history; Pi replacement preserves its
existing freshness semantics instead of copying that persistence policy.

## Required repair and evidence

Keep one ephemeral user-level Pi snapshot at an early stable position during an
unchanged recall epoch. Refreshes still replace it; failures still clear it.
Native histories and canonical memory records remain independent.

At the compaction transport's final payload boundary, chain only when the final
provider representation extends the last successfully acknowledged input and
assistant output. Send just the proven new suffix with `previous_response_id`.
A changed prefix, request shape, identity or model requires a full current or
explicitly compacted rebase. Failed or aborted requests cannot advance the
anchor. Preserve `store`, `context_management`, cache-key selection and official
opaque explicit-compaction results. A recording transport qualifies request
correctness; live raw `response.completed.usage` owns cache measurements.

OpenAI documents the separate chained and stateless compaction paths:
[Compaction](https://developers.openai.com/api/docs/guides/compaction).
Exact-prefix caching and provider write/read policy are described in
[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
The production ChatGPT credential backend must be observed directly rather than
assuming its policy is identical to every public API model.

## Qualification outcome

The shared-memory adapter and local compaction plugin are active. Fresh Web
1.0.0 and terminal 1.0.3 loaders selected exactly the maintained plugin and
shared-memory wrapper, with zero network calls. Web restarted from its verified
launcher, retains `/data/CoordExp/.pi` without a session-directory override, and
serves the page with HTTP 200. CLI reports 1.0.3.

Shared-memory retained callers produced RED on the original source and GREEN on
the candidate in both versions, through fixture recall and real CLI/MCP recall.
The source-linked receipt is
`shared-memory-mcp/outputs/pi-context-prefix-20261005/receipt.json`.
Compaction SSE/loopback WS, native loader execution and explicit artifact
persistence/reconstruction passed both versions. Independent affected review
passed current post-compaction edits, valid versus obsolete inline coverage,
native portable-boundary matching and the OAuth storage constraint. Typecheck
still lacks the already-missing `@types/ws`; runtime qualification passed.
Final plugin receipts are under its
`.local/qualification/pi-continuation-20261005/final/`.

### Bounded live cache contrast

All rows use direct OpenAI ChatGPT OAuth, `gpt-6-luna`, actual low reasoning,
two sequential turns, no tools/retry/warming, the same synthetic reference and
fresh in-memory session IDs. First-turn cached tokens were zero in each row.
The denominator below is raw total input, including cached tokens.

| Profile | Second-turn raw input | Cached input | Second-turn fraction |
| --- | ---: | ---: | ---: |
| Native SDK, original tail recall | 7366 | 0 | 0.00% |
| Native SDK, stable early recall | 7362 | 6912 | 93.89% |
| Repaired plugin, stable early recall | 7361 | 6912 | 93.90% |

The final repaired profile's cold two-turn pooled fraction is 47.02%, because
its first turn also belongs in that denominator. The second-turn improvement
demonstrates a decision-bearing memory-placement effect in this controlled
population. It does not attribute all historical 17.43% behavior, promise a
production rate, or separate every production context-edit/compaction effect.
Small input-count differences arise between fresh session identities and their
recalled caller wrappers; the synthetic conversation is otherwise fixed.

Raw receipts under `.local/diagnostics/cache-20261005/runs/`:

- Original tail: `2026-10-05T10-10-11-519Z-live-none-tail-620890/receipts.jsonl`.
- Stable early: `2026-10-05T10-17-09-794Z-live-none-early-79e4c6/receipts.jsonl`.
- Repaired plugin: `2026-10-05T10-22-00-980Z-live-compaction-early-073757/receipts.jsonl`.

Both original-tail requests completed successfully with raw usage; its older
runner incorrectly required an SSE Content-Type header and therefore reported
a terminal harness failure. The backend omits that header. The later runner
independently verifies streamed `data`/`event` framing without retaining content;
both later profiles completed with exit 0. The original tail's two completed raw
usage records remain valid observations; they were not reissued to replace that
receipt.

The first isolated live attempts made zero model calls: SDK-only startup had
replaced Node's environment-proxy dispatcher with a plain npm Undici dispatcher.
A two-request credential-free discriminator timed out before initialization
and reached the expected HTTP 400 after the installed SDK's own
`configureHttpDispatcher` initialization. The diagnostic now uses that helper.
Pi Web already initializes its dispatcher through `instrumentation-node.ts`;
this result establishes a runner defect, not a production Web proxy defect.
The next live attempt refreshed OAuth successfully and reached the model
endpoint, which returned HTTP 400 on the original plugin's first request.
That rejected call contributes no cache-rate measurement. Three separately
instrumented original-plugin attempts ultimately identified top-level backend
error detail naming `store`. Native SDK requests with `store:false` succeeded.
The repair matches the native SDK's exact direct-OpenAI ChatGPT sign-in
credential classification, sends `store:false`, and establishes no stored
response chain for that path. Official `context_management` remains present,
inline opaque artifacts support stateless replay, and the native cache key is
unchanged. API-key requests retain proven `store:true` response chaining.

Opaque artifacts are valid only for their represented history. A covered memory
or history change invalidates the old inline artifact and uses the complete
authoritative native history with official automatic compaction still enabled.
An unchanged valid lineage can replay the artifact after losing a response
reference. Explicit native compaction has a separately matched portable
boundary and current tail; it never substitutes truncated plaintext for hidden
history or silently restores an obsolete edited tail.

### Official backend compaction boundary

The two offline restored-session fixtures completed two requests each, and a
fixture that removes the opaque artifact failed at the actual request guard
before sending the second request. These qualify the retained consumer path,
not acceptance by the real backend.

The live explicit-compaction RPC returned HTTP 400 before producing any opaque
artifact. A separately instrumented diagnosis also returned 400; its parsed
error names `input`, with finite classifications `unsupported` and `invalid`.
The body was not retained. This establishes rejection of this explicit request
shape on the current direct OpenAI ChatGPT sign-in backend. It does not isolate
the offending input item or prove that automatic `context_management` is
unsupported. The latter remained on both successful repaired cache requests.
No restored-session live follow-up could run without a returned artifact.

Receipts:

- First RPC: `2026-10-05T10-40-02-050Z-compaction-live-2b8a6d/receipts.jsonl`.
- Error diagnosis: `2026-10-05T10-42-51-642Z-compaction-live-37d31c/receipts.jsonl`.

The complete diagnostic used eleven model-endpoint requests out of the stated
twelve-call bound: three original-plugin storage rejections, six completed cache
requests and two explicit-compaction rejections. One call remains unused. There
was no automatic retry. Automatic and explicit official-compaction paths remain
installed and enabled; a live opaque-compaction capability claim is **HOLD**.
No plaintext replacement, endpoint substitution or disabling of compaction was
used to pass qualification. Further backend compatibility work must resolve
this request-shape rejection before claiming live explicit restoration.
