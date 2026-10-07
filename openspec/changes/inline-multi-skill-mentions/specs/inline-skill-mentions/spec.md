## Purpose

Enable explicit, inline references to several installed skills in one Pi Web message, while preserving ordinary text, existing commands and session-specific resource trust boundaries.

## ADDED Requirements

### Requirement: Inline skill completion preserves composition

The composer SHALL offer loaded skill names and descriptions for a `$` reference at the current caret within ordinary text. Selecting a suggestion SHALL complete only that reference, preserve surrounding text and attachments, and allow further references in the same draft. Keyboard and pointer selection MUST be supported without immediately submitting the message.

#### Scenario: Two references in a sentence

- **WHEN** a user completes `$alpha` and then `$beta` in `Use $alpha and $beta for this task`
- **THEN** both references and the rest of the sentence remain in the draft
- **AND** submitting is a separate action

#### Scenario: Completion in the middle of a draft

- **WHEN** a user selects a skill with the caret in a partial dollar token before existing suffix text
- **THEN** only that token is replaced and the suffix remains intact
- **AND** the caret is positioned after the completed reference

### Requirement: Explicit references load real skill instructions

For a Web message with recognized inline skill references, the system SHALL include the referenced skill bodies and their registered locations in the input consumed by the model. Each distinct referenced skill SHALL be included once per message in first-appearance order. The original user request MUST remain present and relative skill resources MUST retain their base-directory meaning. Merely sending literal `$name` text is insufficient.

#### Scenario: Ordered multi-skill expansion

- **WHEN** a session with loaded skills alpha and beta receives `Use $beta, $alpha and $beta`
- **THEN** the model input contains beta's instructions followed by alpha's instructions, each once
- **AND** the user request and registered skill locations remain available

#### Scenario: Explicit-only skill

- **WHEN** a loaded skill has automatic model invocation disabled and the user explicitly references it with `$name`
- **THEN** it can be loaded explicitly just as with `/skill:name`
- **AND** this does not enable its automatic invocation

### Requirement: Skill resolution respects the current session

The system MUST resolve names only through the current session's loaded skill resources and MUST NOT accept arbitrary paths from dollar text or the client as authority to read a file. It SHALL use refreshed resources after reload and the actual loaded resources on session resume. A recognized skill that cannot be read safely within documented size limits MUST produce a visible failure rather than silently omitting or truncating instructions.

#### Scenario: Unavailable project resource

- **WHEN** a project skill is excluded by session trust or resource selection and its name appears in a message
- **THEN** its file is not read or injected
- **AND** the unrecognized reference stays literal

#### Scenario: Unreadable recognized skill

- **WHEN** a recognized skill's file is missing, not regular UTF-8 text, or exceeds the documented bounds
- **THEN** the request fails visibly before model execution
- **AND** no partial collection of selected skill instructions is submitted

### Requirement: Dollar literals and existing workflows remain compatible

The system SHALL leave unrecognized names, escaped dollars, Markdown code spans/fences, doubled dollars and dollars embedded in words or file paths unchanged. It MUST preserve existing `/skill:name` commands, slash built-ins, `@` file references, images and normal draft/history behavior. Purely numeric currency text SHALL NOT be interpreted as a skill reference. Loaded skill references MUST remain literal `$name` text in the user transcript rather than accidentally becoming paired inline math; ordinary unrelated math and raw persisted/copied input MUST remain unchanged.

#### Scenario: Non-reference dollar text

- **WHEN** a message contains `$unknown`, `\$alpha`, `` `$alpha` ``, a fenced code example, `$20`, `$$alpha` or `/tmp/$alpha`
- **THEN** none of those occurrences causes a skill file read or instruction injection

#### Scenario: Existing slash and file controls

- **WHEN** a user uses `/skill:alpha`, a slash built-in or an `@` file suggestion
- **THEN** their existing selection and execution contracts remain intact

#### Scenario: Transcript preserves skill dollars and unrelated math

- **WHEN** a user sends `Use $alpha and $beta` with both skills loaded
- **THEN** the rendered request retains both literal dollar references rather than interpreting them as one math expression
- **AND** raw message content and ordinary unrelated math rendering remain unchanged

### Requirement: Supported Web message modes share expansion

The system SHALL apply inline skill loading to ordinary prompts, steering messages and follow-up messages accepted by the existing Web session interface, including after session resume or reload. Expansion MUST NOT recursively treat generated skill body text as additional user references, and MUST NOT alter non-Web subagent resource policy.

#### Scenario: Queued reference reaches the next model turn

- **WHEN** a streaming session accepts a steering or follow-up message containing two known skill references
- **THEN** the consumer receives both skill bodies once when processing that queued message

#### Scenario: Reload changes the selected skill body

- **WHEN** a registered skill is changed and the Web session reloads resources before another dollar-reference request
- **THEN** the next request uses the refreshed body rather than a stale cached expansion
