# Bounded artifact diagnostics

`bin/pi-diagnostics.mjs` is a deliberately separate, local, read-only projection tool. It does not replace Pi's ordinary `read` tool, alter session/statistics code, or write a transformed journal. It reads a regular file with a read-only descriptor; it does **not** call `SessionManager.open()` or another SDK loader that may migrate/rewrite a journal or skip malformed lines. Journal coverage comes from this tool's own direct JSONL scan and is qualified in every result.

The CLI prints one JSON projection to stdout. Errors are a small JSON object on stderr and exit with status 2; source excerpts and parser exception text are never included. The helper is dependency-free and uses the Node runtime already required by Pi Web.

## Journal projection

A journal invocation must name an inclusive, finite, 1-based source line range. The session header at line 1 is read separately to identify and validate the format (supported versions 1–3), even when the requested range starts later. Scanning stops at `--to-line`; later appends are outside the projection. If the source changes during the read, that fact is disclosed and `coverage.complete` is false. Do not use an unbounded tail/follow mode for a growing journal.

```sh
node bin/pi-diagnostics.mjs journal \
  --file ~/.pi/agent/sessions/ENCODED_CWD/SESSION.jsonl \
  --from-line 1 --to-line 318 --mode usage

node bin/pi-diagnostics.mjs journal \
  --file ./session.jsonl --from-line 120 --to-line 180 --mode toolCalls \
  --tool-argument-pointer /file_path

node bin/pi-diagnostics.mjs journal \
  --file ./session.jsonl --from-line 1 --to-line 318 --mode text \
  --max-rows 12 --max-text-chars 1200
```

Modes:

- `usage` (default) emits per-entry raw usage fields only: message usage and `compaction`, `branch_summary`, or `usage` entry usage. It does not invent a new aggregate/category taxonomy or total.
- `toolCalls` emits call IDs/names and source locations. Arguments are opaque and omitted unless one or more `--tool-argument-pointer` values explicitly select fields. Selected argument values remain depth/row/text/output bounded.
- `text` emits only user/assistant plain text blocks (or a string message body). Thinking, tool results, images, custom messages, and other nested content are not included. This mode is intentionally opt-in; displayed text may contain user data.

The default projection never emits signatures, encrypted/ciphertext fields, credentials, or arbitrary nested history. Opaque-key counts are disclosed as `opaqueFieldsOmitted`. Blocked keys cannot be selected. Text and argument values are bounded even when explicitly selected.

Each journal result includes the resolved source path, device/inode, snapshot byte size and mtime, read-only marker, session ID/version, entry line and ID (when present), requested range and its exact source-byte count, bytes scanned (which can include bounded read-ahead), display/row omissions, parse issues by line and code, and whether the source changed. `coverage.complete` describes byte/line/JSON coverage of the selected range, not semantic completeness of every possible future journal entry type; `projectionComplete` is separately false when an unrecognized entry type occurs. Malformed complete JSONL lines and partial EOF lines are disclosed without quoting their contents. Valid records after a malformed line are still projected. Unsupported headers/versions fail visibly rather than being guessed.

## Explicit JSON Pointer projection

JSON mode requires at least one non-root RFC 6901 JSON Pointer. There is no inferred field set or implicit ledger interpretation. Select a small, relevant field or collection:

```sh
node bin/pi-diagnostics.mjs json \
  --file ./metrics.json \
  --pointer /runs/0/usage \
  --pointer /summary/cacheRead
```

Missing selectors, malformed pointer escapes, duplicate pointers, and prototype/opaque-field selectors fail visibly. Values are parsed with number lexemes retained until selection. A selected number is emitted as a JavaScript JSON number only when its emitted decimal is mathematically equivalent to the source lexeme (so exponent-equivalent forms such as `1e3` and `1000.000` remain numbers). Values such as `9007199254740993`, rounded long decimals, underflow/overflow, and sign-sensitive negative zero are rejected before a projection is returned. The parser does not silently turn them into rounded numbers or strings.

The file must fit the input byte admission cap before parsing starts; an oversized JSON document is rejected, never partially parsed. A source changed during JSON admission is also rejected. Selected objects/arrays preserve retained primitive types and values. Collection, depth, text, and output clipping is explicitly reported under `omissions`; it does not imply that omitted items were validated as displayable values. Numeric precision is checked for all numbers beneath every selected pointer before display clipping.

## Bounds and disclosure

Defaults and hard maxima are enforced by the helper; CLI values can lower or raise a default only up to the listed maximum:

| Limit | Default | Hard maximum |
| --- | ---: | ---: |
| Input bytes (JSON document or journal bytes scanned through the selected end line) | 8 MiB | 8 MiB |
| Journal line bytes | 2 MiB | 8 MiB |
| Output JSON bytes (including CLI newline) | 32 KiB | 64 KiB |
| Display rows per collection/top-level journal projection | 25 | 100 |
| Display nesting depth | 8 | 16 |
| Display text | 4,000 UTF-16 code units | 16,000 |
| Selected journal range | finite, max 10,000 lines | absolute line number 1,000,000 |

A JSON file over the input limit fails before parsing. Journal input admission covers bytes scanned from line 1 through the requested end line (including the header and skipped prefix), so a late range in a very large file can fail admission instead of being silently truncated. A too-long journal line is disclosed and scanning continues to later lines when the byte admission cap allows it. Output bytes, effective limits, omitted row/item/text counts, malformed positions and source identity are included in the result. No files are written by this CLI; stdout/stderr are the only output channels.

The output cap and bounded parser do not make selected artifacts non-sensitive. Keep diagnostic output local and select only fields needed for the question. The tool is not a scientific-ledger validator, session migration utility, signature reader, general-purpose tree viewer, or substitute for exact raw evidence.
