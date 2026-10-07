# Pi compaction backend and Full default, 2026-10-06

Historical runtime receipt for 2026-10-06, not a declaration of the current
profile or package owner. Later extension changes belong to their separate
repository; this fork's publication checks are recorded in
[fork-publication-qualification.md](fork-publication-qualification.md).

The shared profile now loads only `npm:@narumitw/pi-codex-compact@0.55.0`
for compaction. CLI and Web retain the managed Pi 1.0.3 installation and
`/data/CoordExp/.pi` profile. Successful CLI and Web probes persisted encrypted
checkpoints through `context-management` and recovered information preceding
the compaction boundary. Web now defaults new chats to Full.

## Original evidence and failure boundaries

The requested conversation is
`/data/CoordExp/.pi/sessions/--data-CoordExp--/2026-10-06T03-22-13-970Z_01a10f3b-b651-7204-ab11-5e26b8f8769a.jsonl`.
Its earlier investigation referenced the research conversation
`01a10ce3-4348-7204-ab11-5e1af9835c40`, whose compaction had `fromHook:true`
but no `details.remoteCompaction`. Its historical remote rejection reason was
not persisted; present reproduction does not prove that exact historical cause.

Three current boundaries explain how native/text compaction remained possible:

1. The active package was the maintained `pi-openai-server-compaction` source;
   `pi-codex-compact` 0.54.0 was installed but not registered. The active source
   generated a portable text summary concurrently with remote compaction and
   returned it before notifying about a remote rejection.
2. Fresh CLI loading reproduced `Cannot find module
   '@earendil-works/pi-ai/compat'`. The old source's `import.meta.resolve` in
   `src/provider-input.ts` requires physical package resolution; resolving that
   specifier from its checkout also produced `MODULE_NOT_FOUND`. Pi's host SDK
   contains the export, but that alone does not make this local source load.
3. The old protocol sends `/v1/responses` with `compaction_trigger`. A bounded
   request using the current OpenAI ChatGPT subscription route reproduced HTTP
   400, `subscription_sharing_unsupported_capability`, `param=input`. The backend
   explicitly rejected unsupported input items. This does not establish a
   network failure or lack of ordinary inference permission.

Web's `toolNames:[]` additionally selects chat-only and skips all extensions.
The selected solution is the user's requested Full workflow; chat-only retains
its existing loading contract.

## Selected runtime behavior

`/data/CoordExp/.pi/settings.json` registers the single npm compaction package.
`/data/CoordExp/.pi/pi-codex-compact.json` contains:

```json
{
  "enabled": true,
  "protocol": "context-management",
  "notifyOnFallback": true,
  "maxRetries": 0
}
```

Context Management uses a normal Responses stream with a compaction threshold,
without a `compaction_trigger`. Success persists version 3 checkpoint details
and replays opaque history on compatible requests. No additional portable
summary request is needed on this successful path. The upstream extension still
allows Pi-native fallback with a warning if a remote request fails; this is a
remote default, not a strict prohibition on fallback. Unsupported model APIs
retain native compaction. Compatibility also depends on the checkpoint model/API.

The shared `defaultTools` already matched Full's seven built-ins: `bash`,
`read`, `edit`, `write`, `grep`, `find`, `ls`. Web's browser preference could
override that with a saved `none`. `lib/tool-preset-preference.ts` therefore owns
the Full default and one-time `full-20261006` browser preference migration.
Later explicit dropdown choices remain authoritative. The initial hook state
uses the same owner. Existing unrelated sessions are not bulk rewritten.

The requested Web conversation was set to Full while idle and reloaded through
its session API. Its registered commands include `codex-compact`. The existing
Web service was not restarted. Browser preference migration occurs when the
updated client loads; refresh the page before creating a new chat.

## Qualification and retained receipts

Private receipts and pre-change settings are under
`.local/diagnostics/compact-20261006-01a11021/`. Auth files were not copied into
the diagnostic packet. Package integrity is recorded in `package-receipt.json`.

- `cli-reconciled.json`: compaction persisted one encrypted checkpoint, 3,300
  encrypted-content characters; summary and retained cut point lacked the test
  codeword. Both compaction and fresh-process resumed CLI exited 0; the resumed
  prompt recovered the earlier codeword.
- `web-summary.json`: Full-mode Web compaction returned and persisted one
  encrypted checkpoint, 28,044 encrypted-content characters; the follow-up
  recovered its earlier codeword. Both Web API operations returned 200. The
  disposable test session was removed through Web's session owner after its
  full history was retained as `web-session.jsonl` in this diagnostic packet.
- `protocol-proxy-summary.json`: one transport-correct old-protocol request
  received the operation-specific HTTP 400 above.
- `protocol-summary.json`: an earlier standalone SDK diagnostic timed out
  without an HTTP status. It omitted Pi's HTTP-dispatcher initialization and
  does not answer backend protocol compatibility. The corrected invocation
  adopted the retained CLI/Web dispatcher; it did not change credentials.
- `user-session-activation.json`: named conversation set to Full and reloaded,
  with the new command present and no model call.

The CLI harness originally exited 1 after its successful compaction and resume
because a preload HTTP recorder produced no receipt file. Pi's dispatcher
installs its own fetch implementation after the preload. Functional results
and process exits are retained; request-level tracing for those CLI operations
remains unverified. No completed model operation was repeated to repair that
recorder. Six explicit model-endpoint operations/attempts were launched: two CLI,
two protocol diagnostics, and two Web. No GPU work was used.

Preference regressions first failed against the previous implementation, then
the 19 targeted preference/preset/session-selection tests passed. TypeScript
`tsc --noEmit` and `git diff --check` passed. No build, commit or push was run;
pre-existing unrelated dirty files were preserved. These synthetic probes
qualify backend return, persistence and continuation, not comparative compression
quality or a natural large-conversation automatic-compaction run.

Protocol references: [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)
and [ChatGPT models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
