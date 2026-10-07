# Opt-in final HTTP request diagnostics

Source qualification only: this feature does not enable itself in the running server, change a profile, reload sessions, or adopt a release. No cache improvement is claimed.

## Enablement and scope

An operator may set **`PI_WEB_REQUEST_DIAGNOSTICS=1`** in the Web host's infrastructure environment before separately authorized startup. Any other value is off. This is not a model option or an extension setting. Off creates no host, listener, fetch wrapper, or diagnostic file. Compact has its independently owned global-only `requestDiagnostics: false` setting; both participants must opt in for compact-to-Web records.

`lib/rpc-manager.ts` passes a public SDK `eventBus` to its resource loader, wraps the captured public `session.agent.streamFunction`, and releases observation on closing, destruction, replacement, or tracking-slot eviction. No Pi core/private extension imports are used. Sessions constructed independently of `startRpcSession` (notably independently constructed live subagents) are **not** currently installed by this integration; reopening through that entry point is covered.

Qualified coverage is the installed SDK 1.0.3 **built-in `openai-responses` HTTP fetch seam**, with no supplied custom fetch and no registered native/custom stream implementation. API-compatible endpoint configuration using the built-in adapter is supported. Google/Vertex, other APIs and custom implementations receive the exact original options. Supplied fetch delegates receive their original options and are unqualified, even if they would happen to return identical bytes.

The wrapper preserves payload/response/provider callbacks, signals, retries, transport choice and the original Response. It never reads, clones or tees a Response body. A dispatch observation is the materialized `init.body` string immediately before calling the captured fetch—not `onPayload`. Request objects without an inspectable string in `init.body`, streams and oversized bodies are unobserved; they are never read for diagnostics. A qualified invocation that makes no observed HTTP fetch gets `transport-unobserved` (including WebSocket or pre-dispatch failure). This is **not universal wire coverage**, and transport is never changed to obtain coverage.

All Web request kinds are `unknown`: this stream function also serves native compaction and branch summaries. SDK warming captures and reuses request options outside this function. Each actual fetch therefore receives new opaque operation/attempt IDs; Web's operation ID is a conservative transport-operation identity, **not a promise to group retries, warming or a whole user turn**. With only one dispatch in a captured callback family, raw completion may join that attempt. Once callbacks have served multiple dispatches, raw terminals carry unknown identity; they never join the last attempt. HTTP failures/abort can still identify their own fetch attempt. No warming setting is disabled.

## Public cross-repository protocol

Channel: **`pi:request-observation:v1`**, on extension `pi.events` / SDK `eventBus`. Producers implement this schema independently, without importing another extension's private module. The envelope is frozen; usage is a detached, frozen primitive-only object. Body is an immutable string, transiently visible to privileged in-process listeners. Never send mutable request arguments or raw provider events.

Common fields:

```ts
{
  version: 1;
  phase: 'dispatch' | 'terminal' | 'unobserved';
  sessionId: string; operationId: string; attemptId: string;
  provider: string; api: string; model: string;
  kind: 'unknown' | 'compaction';
}
```

Phase-specific fields:

```ts
// dispatch: allocate an actual attempt ID at the transport boundary
{ body: string; coverage: 'http-final' | 'unknown' }

// terminal: reserve attemptId: 'unknown' for ambiguous correlation.
// Web also uses operationId: 'unknown' when the operation is ambiguous.
{
  status: 'completed' | 'error' | 'aborted';
  usage: {
    cachedTokensState: 'absent' | 'zero' | 'value' | 'invalid';
    cachedTokens?: number; inputTokens?: number; outputTokens?: number;
  };
  responseId?: string;
}

// unobserved
{ reason:
    'unsupported-adapter' | 'custom-fetch' | 'transport-unobserved'
  | 'body-unmaterialized' | 'body-oversized' | 'observation-failed'
  | 'attribution-unknown' }
```

`attemptId` remains required: no additional public attribution field is needed. The host adds persisted `attribution: 'exact' | 'unknown'` only after validating originating session, operation, attempt, provider, API, model and kind. Missing/evicted/unmatched/unknown attempts cannot inherit a previous dispatch. `responseId` is evidence for comparison, not authority to guess a missing attempt.

All IDs and free-form metadata must be nonempty strings at most 1,024 UTF-8 bytes. Accessors and non-primitive enum lookalikes are rejected. Unknown extra fields are ignored, never copied. Cache counts must be nonnegative safe integers: zero requires `cachedTokens: 0`; value requires a positive count; absent/invalid must omit that count. Optional input/output counts must also be nonnegative safe integers. An absent raw `input_tokens_details.cached_tokens` is **not normalized to zero**. Invalid raw values become state `invalid`, without retaining their source value.

The event bus is a privileged local interface, not a security boundary between extensions. The host's privacy guarantee covers its own records only. Other extensions, provider callbacks, or the SDK's logging of another listener's thrown error can independently expose data; this observer neither intercepts nor promises to sanitize those unrelated outputs. Its own errors are counted without logging exception text.

## Privacy and finite retention

`lib/request-diagnostics.ts` holds a random per-process HMAC key and comparison epoch (retained across Web module hot reload via `globalThis`). Restart creates a new epoch; do not compare fingerprints across epochs. All producer-supplied metadata, even model/provider/API and response IDs, is HMAC-tagged before persistence. A host-generated observer generation distinguishes replacements. No prompt, raw body, signature, authorization/header, URL, arbitrary provider error or mutable event enters the sink queue.

Records include exact body-byte HMAC/length, ordered JSON section HMACs/lengths for a small fixed allowlist, and up to the first 32 input-item HMACs plus cumulative **HMAC-chain** tags. The chain is an ordered comparison aid, not a hash of concatenated wire bytes; JSON section serialization is not semantic canonicalization. Input count and omissions are disclosed. Parsing can fail while the original materialized body's byte fingerprint remains available; `parsed: false` makes that distinction explicit.

Hard bounds:

| Surface | Bound |
| --- | --- |
| Materialized body admission/parsing | 8 MiB UTF-8 |
| Serialized record | 16 KiB |
| Pending writer backlog, including active write | 128 records **and** 256 KiB |
| Host tracking | 64 sessions / 128 attempts |
| Input item fingerprints | 32 |
| Durable retention | `requests.jsonl` + `requests.previous.jsonl`, each at most 1 MiB |

Sink location is the Web host working directory's **`.local/diagnostics/`** (normally the physical Pi Web root). Directory mode is 0700; files are 0600. Symlink final directories/files are refused. The process-singleton sink serializes writes and rotates only these two owned filenames. It never writes session journals. Diagnostic receipt subdirectories are separate qualification artifacts, not part of the runtime ring.

Observation never awaits disk. Full backlogs drop the new record; IO failures discard that write. `sink.dropped`, `oversized`, `failures`, pending counts and tracking rejection/eviction counters are included in later accepted records and exposed through helper `stats()`. A permanently stalled or failed sink cannot durably report its own final losses: no complete-coverage claim is valid in that state. Evicting a session also releases its listener/wrapper; evicted attempts make later terminals unknown. Disposal invalidates captured callbacks without suppressing their underlying dispatch.

## Qualification

Targeted tests:

```sh
node --experimental-strip-types --test lib/request-diagnostics.test.mjs \
  lib/request-diagnostic-observer.test.mjs lib/request-diagnostic-sdk.test.mjs \
  lib/request-diagnostic-rpc.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
node_modules/.bin/eslint lib/request-diagnostic*.ts lib/request-diagnostic*.test.mjs lib/rpc-manager.ts
```

The SDK suite uses only temporary in-memory sessions and loopback HTTP servers, with no external provider calls or credential/profile changes. It compares server-received bytes after a late extension hook against final observation, distinguishes absent/zero/invalid raw cache values, exercises interleaved sessions, actual provider retry, actual overlapping SDK warming, native compaction and branch summary. Unit tests cover immutable/mutating listeners, invalid metadata/error sentinels, tracking replacement/eviction, late callbacks, unsupported transports/bodies, stalled/failing IO and private rotation. RPC lifecycle tests check cleanup before asynchronous extension shutdown finishes.

The cross-repository compact join is an explicit qualification target, not a
standalone Web unit test or an implicit sibling-checkout dependency:

```sh
PI_WEB_COMPACT_SOURCE_ROOT=/path/to/pi-codex-compact \
  npm run test:compact-integration
```

It binds imports to the host's actual SDK packages (qualified version 1.0.3) and
requires the named compact source package. It exercises observation off/on and
adversarial listeners while retaining checkpoint publication, reload and replay.

Receipts: `.local/diagnostics/pi-cache-efficiency-wave2/`. Generated compact transport/checkpoint qualification and the cross-repository join remain compact-worker/lead-owned. Native summaries tested here do not qualify extension-owned opaque checkpoint semantics. The lead owns acceptance and task checkboxes; no deployment, build, live-server restart, external model request, or hosted cache-benefit claim is included.
