# Inline `$skill` references

Pi Web supports explicit skill references inside ordinary messages, in addition
to the existing leading `/skill:name` command. For example:

```text
请使用 $native-agent-team-guidance 和 $git-hygiene 来完成这项任务。
```

Type `$` at the caret to see skill suggestions from the current command catalog.
Complete a suggestion with the keyboard or pointer, then continue composing the
message. Completion replaces only the current dollar token, not the rest of the
draft. Several references can be included in one message; selection does not
submit it. Existing slash commands and `@` file completion remain separate.

## What is loaded

At send time, the Web session resolves names against **its loaded skill catalog**.
It reads each recognized skill's instructions once per message, in first-reference
order, preserving the registered location and relative-resource base directory.
The original request remains present. Repeating `$name` does not inject another
copy of that skill into the same message. The transcript preserves these dollar
references as text instead of treating a pair as inline math; copying/editing and
persisted input stay raw, and ordinary unrelated math still renders normally.

This applies to ordinary Web prompts and supported steering/follow-up messages,
including sessions reopened or reloaded through the existing Web controls. Skill
bodies are not recursively scanned for more dollar references. A skill with
`disable-model-invocation: true` can still be explicitly referenced; this does not
turn on automatic invocation. Trust decisions and resource selection still decide
which skills belong to the loaded catalog. The adapter does not add resources to
non-Web subagents.

## Literal text and bounds

- Unknown names remain literal text; they do not trigger a global skill search.
- Dollar tokens in Markdown code spans/fences, escaped dollars, doubled dollars,
  and dollars embedded in words or paths are not references.
- Purely numeric currency such as `$20` is not a reference.
- Names follow the SDK's lowercase letter/digit/hyphen grammar, up to 64
  characters, without leading/trailing/consecutive hyphens; a dollar reference
  must contain at least one letter. Numeric-leading names such as `$3d-tools`
  are supported.
- `$path/to/file` is **not** an arbitrary file attachment. Use the existing file
  controls for files; client-supplied paths are not skill-loading authority.
- Web inline loading allows up to 16 distinct skills, 128 KiB per skill file and
  1 MiB aggregate per message. A recognized file that is missing, unsafe,
  invalid UTF-8 or too large fails before model execution; instructions are not
  silently truncated or partially submitted. These limits do not redefine SDK
  slash loading or automatic skill behavior.

Registered extension slash-command arguments are left to the command rather than
rewritten as model input. The existing `/skill:name` input path remains available.

The Web adapter runs before the SDK's normal input pipeline. Third-party input
extensions can still intentionally handle or replace input through their existing
public hooks; this feature does not override those extensions.

## Ownership and acceptance

The feature is owned by this fork's composer, mention helpers and Web send adapter,
not by a Pi Core fork or an external extension package. Its specification and task
record live under `openspec/changes/inline-multi-skill-mentions/`.

The intended style is based on the inspected public Codex implementation, which
supports multiple selected skill identities and instruction fragments. This is
not a claim that Pi Web duplicates the private Codex APP frontend or protocol.
See [local qualification](inline-skills-qualification.md) for the accepted test
matrix and evidence. Publication, hosted CI and runtime deployment remain
separate from local tests.

The standalone browser smoke is `node e2e/inline-skills.mjs`. It requires the
installed Playwright version's Chromium headless shell. To provision its private
cache on a development machine:

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/qualification/inline-skills/browser-cache" \
  npx playwright install chromium --only-shell
node e2e/inline-skills.mjs
```

The smoke launches a private source snapshot with its own Next dev output,
temporary profile/workspace and loopback fake provider. It does not intercept
agent APIs, use hosted models, or build/restart the active checkout. The snapshot
adapts only the common resolver/tracing root needed for its installed SDK links;
the active `next.config.ts` remains unchanged. Its workspace has a test-owned Git
boundary so the host's ignored `.local/` does not hide `@` fixture files. Optional
npm update checks and external Google font fetching are disabled using existing
test/runtime hooks; no agent API or SSE route is mocked. Browser caches and raw evidence
are private ignored files, not source to commit.
