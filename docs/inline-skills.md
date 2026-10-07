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
The original request stays short and unchanged: generated instructions are not
appended to user-authored text. The Web integration retains the registered
name/path identities and loaded instruction snapshots separately in versioned
`message.piWeb.inlineSkillContext` metadata. A public SDK context adapter supplies
one distinct model-context message per selected skill immediately after the
originating user message; the agent does not need to issue a second file read.

The transcript shows the original request and compact skill references. Instruction
bodies are inspectable on demand, not displayed by default. Copying/editing uses
only the original request; images are retained. Repeating `$name` does not inject
another copy into the same message. Skill dollars remain literal instead of
becoming paired inline math, and ordinary unrelated math still renders normally.

Existing inline-expanded history receives display-only compact restoration for
complete recognized appended envelopes. Its stored text is not rewritten. Broken,
code-quoted or nonmatching lookalikes remain ordinary text. Existing leading
`/skill:name` display and SDK loading are unchanged.

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

The Web adapter preflights before the SDK's normal input pipeline. Snapshots travel
with their actual originating user-message objects rather than in an independent
context queue. Cancelled or consumed submissions must not leave instructions for
a later unrelated request. Third-party input extensions can still intentionally
handle or replace input through their existing public hooks; this feature does
not override those extensions.

Reload or a new explicit reference loads current registered files. Reopening a
Web session instead projects its retained historical snapshots, so later edits
to a skill file do not silently change what an old request means. Branch selection
and compaction follow the SDK's retained context; discarded history is not
resurrected by looking up live skill files.

Compact display is not a token-saving claim. Full instructions still enter model
context, whether loaded by the harness or through a model-issued read. This change
deduplicates within each originating message, not across all future turns.

## Ownership and acceptance

The feature is owned by this fork's composer, mention helpers and Web send adapter,
not by a Pi Core fork or an external extension package. Its specification and task
record live under `openspec/changes/inline-multi-skill-mentions/`.

The intended style is based on the inspected public Codex implementation, which
submits short text and selected name/path identities separately, then loads full
instruction fragments in its backend. The Web representation uses a narrowly
scoped public `Agent` method adapter and public SDK context extension, not a
new Pi Core protocol. Native Pi CLI does not install this Web adapter and therefore
does not automatically reproject the Web-specific stored snapshots; native-CLI
model-context portability is outside this change.

This supports multiple selected skill identities and instruction fragments. This is
not a claim that Pi Web duplicates the private Codex APP frontend or protocol.
See [correction qualification](inline-skill-context-qualification.md) for the
accepted compact-message, SDK lifecycle and browser test matrix and evidence. Publication, hosted CI and runtime deployment remain
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
