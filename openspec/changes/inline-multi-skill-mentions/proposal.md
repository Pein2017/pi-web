## Why

Pi Web's leading `/skill:name` command expands one skill and replaces the composer during completion. Users need Codex-style `$name` references embedded in ordinary text, with several skills in one request and deterministic loading of their instructions.

## What Changes

- Add cursor-aware `$` skill completion throughout the composer, preserving surrounding text, attachments and existing slash/file completion.
- Resolve inline names against the active Web session's loaded skill catalog and include each referenced skill's instructions once, in first-appearance order.
- Apply the same expansion to ordinary prompts and supported queued steer/follow-up inputs through Web-owned public SDK integration.
- Keep unknown references, escaped dollars and code literals unchanged; retain existing `/skill:name` behavior and session trust/resource restrictions.
- Record bounded regression and real SDK/browser acceptance evidence.

No Pi Core modification, arbitrary `$path` file attachment, new skill installer, automatic workflow execution, private Codex APP implementation claim, runtime profile mutation, deployment or publication is included. This adds opt-in text syntax without removing upstream commands.

## Capabilities

### New Capabilities

- `inline-skill-mentions`: Inline multi-skill composition, safe session-catalog resolution and deterministic instruction loading in Pi Web.

### Modified Capabilities

None; this independently maintained fork has no existing stable specs.

## Impact

The composer (`components/ChatInput.tsx`), client-safe mention helpers, Web session SDK wiring (`lib/rpc-manager.ts`), regression/integration tests and project-local docs. The existing command discovery API is reused unless actual session-catalog parity requires a narrow Web-only adjustment. Official Pi SDK remains a separate dependency; no new runtime package is required.
