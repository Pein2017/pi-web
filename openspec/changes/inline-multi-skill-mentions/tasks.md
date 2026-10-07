## 1. Shared syntax and trusted loading

- [x] 1.1 Implement the shared mention lexer and caret query with RED/GREEN tests for multi-reference order, offsets, currency, code/escape/embedded dollars and invalid-token prefix exclusion.
- [x] 1.2 Implement atomic bounded active-session skill loading with regression tests for once-per-skill ordering, registered location/baseDir, explicit-only skills, unknown names, refused unsafe/unreadable/oversized files and no recursive expansion.
- [x] 1.3 Wire Web prompt, steer and follow-up through the fail-closed adapter; verify real installed-SDK/faux-provider consumer tests including reload/resume, trust/resource exclusions, images and unchanged slash behavior, with non-Web subagent policy retained.

## 2. Composer interaction

- [x] 2.1 Add cursor-local dollar completion using only skill catalog entries, with keyboard/pointer selection and preserved prefix/suffix/caret; verify focused RED/GREEN tests.
- [x] 2.2 Preserve slash/file completion, IME, streaming queue, attachments and draft/history behavior; verify existing affected tests plus separate demo checks if mirrored.

## 3. Integrated acceptance

- [x] 3.1 Qualify the actual browser composer to Web API/SDK terminal-consumer slice with test-owned fixtures and no paid model calls; retain evidence for two skills, deduplication, literals, queued modes and compatibility.
- [x] 3.2 Run final full standalone tests, Web typecheck/lint, affected demo checks and strict OpenSpec validation; inspect final scoped diff and preserve unrelated/generated state.
- [x] 3.3 Document usage, limits, ownership and acceptance evidence in this repository; distinguish local qualification from hosted CI, runtime deployment and private Codex APP parity.

## 4. Correct compact messages and independent skill context

- [x] 4.1 Implement durable per-request instruction snapshots and separate model-context delivery using public SDK integration; prove unchanged raw user text and fail-closed bounded loading with RED/GREEN checks.
- [x] 4.2 Qualify request/context association through prompt, steer, follow-up, cancellation, handled/rejected input, reload, reopen and branch reconstruction; no orphaned or re-read historical instructions.
- [x] 4.3 Add compact reference presentation, opt-in instruction inspection, short copy/edit and strict display-only compatibility for legacy appended history; retain math/slash/files/images and demo parity.
- [x] 4.4 Qualify real browser/Web API/installed-SDK/provider input and persisted readback; run current standalone/static/demo checks and strict OpenSpec validation, then document corrected behavior and local evidence.
