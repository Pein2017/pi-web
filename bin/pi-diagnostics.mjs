#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { DiagnosticProjectionError, projectJsonArtifact, projectSessionJournal } from "../lib/session-diagnostic-projection.mjs";

const HELP = `Read-only, bounded diagnostic projections for a Pi session journal or an explicitly selected JSON artifact.

Usage:
  node bin/pi-diagnostics.mjs journal --file PATH --from-line N --to-line N [--mode usage|toolCalls|text]
      [--tool-argument-pointer JSON_POINTER ...] [bounded-limit flags]
  node bin/pi-diagnostics.mjs json --file PATH --pointer JSON_POINTER [--pointer JSON_POINTER ...] [bounded-limit flags]

Bounded-limit flags (defaults in parentheses):
  --max-input-bytes N  (8388608; hard maximum 8388608)
  --max-line-bytes N   (2097152; hard maximum 8388608)
  --max-output-bytes N (32768; hard maximum 65536)
  --max-rows N         (25; hard maximum 100)
  --max-depth N        (8; hard maximum 16)
  --max-text-chars N   (4000 UTF-16 code units; hard maximum 16000)

Journal ranges are finite, 1-based, and inclusive. JSON Pointer selectors are required in JSON mode.
Tool arguments and journal text are never displayed unless their mode/selector is explicitly requested.
`;

const VALUE_OPTIONS = new Map([
  ["--file", "filePath"],
  ["--mode", "mode"],
  ["--from-line", "fromLine"],
  ["--to-line", "toLine"],
  ["--pointer", "pointer"],
  ["--tool-argument-pointer", "toolArgumentPointer"],
  ["--max-input-bytes", "maxInputBytes"],
  ["--max-line-bytes", "maxLineBytes"],
  ["--max-output-bytes", "maxOutputBytes"],
  ["--max-rows", "maxRows"],
  ["--max-depth", "maxDepth"],
  ["--max-text-chars", "maxTextChars"],
]);

const NUMERIC_OPTIONS = new Set([
  "fromLine",
  "toLine",
  "maxInputBytes",
  "maxLineBytes",
  "maxOutputBytes",
  "maxRows",
  "maxDepth",
  "maxTextChars",
]);

function parseInteger(value, option) {
  if (!/^\d+$/.test(value)) throw new DiagnosticProjectionError("invalid-option", `${option} requires a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new DiagnosticProjectionError("invalid-option", `${option} is outside the supported integer range.`);
  return number;
}

function parseArguments(args) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return { help: true };
  const [command, ...rest] = args;
  if (command !== "journal" && command !== "json") {
    throw new DiagnosticProjectionError("invalid-command", "Command must be 'journal' or 'json'.");
  }
  const options = { pointers: [], toolArgumentPointers: [] };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    const key = VALUE_OPTIONS.get(flag);
    if (!key) throw new DiagnosticProjectionError("invalid-option", `Unsupported option: ${flag}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new DiagnosticProjectionError("invalid-option", `${flag} requires a value.`);
    index++;
    if (key === "pointer") options.pointers.push(value);
    else if (key === "toolArgumentPointer") options.toolArgumentPointers.push(value);
    else if (NUMERIC_OPTIONS.has(key)) {
      if (Object.hasOwn(options, key)) throw new DiagnosticProjectionError("invalid-option", `${flag} may be specified only once.`);
      options[key] = parseInteger(value, flag);
    } else {
      if (Object.hasOwn(options, key)) throw new DiagnosticProjectionError("invalid-option", `${flag} may be specified only once.`);
      options[key] = value;
    }
  }
  if (!options.filePath) throw new DiagnosticProjectionError("missing-file", "--file is required.");
  if (command === "json" && options.pointers.length === 0) {
    throw new DiagnosticProjectionError("missing-selector", "JSON mode requires one or more explicit --pointer values.");
  }
  if (command === "journal" && (!Object.hasOwn(options, "fromLine") || !Object.hasOwn(options, "toLine"))) {
    throw new DiagnosticProjectionError("invalid-range", "Journal mode requires finite --from-line and --to-line values.");
  }
  if (command === "json" && options.toolArgumentPointers.length) {
    throw new DiagnosticProjectionError("invalid-option", "--tool-argument-pointer is only valid in journal toolCalls mode.");
  }
  return { command, options };
}

export async function runCli(args = process.argv.slice(2)) {
  try {
    const parsed = parseArguments(args);
    if (parsed.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const result = parsed.command === "journal"
      ? await projectSessionJournal(parsed.options)
      : await projectJsonArtifact(parsed.options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof DiagnosticProjectionError ? error.code : "diagnostic-failed";
    const message = error instanceof DiagnosticProjectionError ? error.message : "Diagnostic projection failed.";
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  runCli().then((status) => {
    process.exitCode = status;
  });
}
