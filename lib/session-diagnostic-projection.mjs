import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { TextDecoder } from "node:util";

const DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 8 * 1024 * 1024,
  maxLineBytes: 2 * 1024 * 1024,
  maxOutputBytes: 32 * 1024,
  maxRows: 25,
  maxDepth: 8,
  maxTextChars: 4_000,
});

const ABSOLUTE_LIMITS = Object.freeze({
  maxInputBytes: 8 * 1024 * 1024,
  maxLineBytes: 8 * 1024 * 1024,
  maxOutputBytes: 64 * 1024,
  maxRows: 100,
  maxDepth: 16,
  maxTextChars: 16_000,
});

const MAX_SESSION_RANGE_LINES = 10_000;
const MAX_SESSION_LINE_NUMBER = 1_000_000;
const MAX_SELECTORS = 16;
const MAX_POINTER_LENGTH = 256;
const MAX_ISSUES = 64;
const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_NODES = 250_000;
const IO_CHUNK_BYTES = 64 * 1024;
const OPAQUE_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "signature",
  "signatures",
  "encrypted",
  "encryptedpayload",
  "ciphertext",
  "privatekey",
  "secret",
  "clientsecret",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "apitoken",
  "bearertoken",
  "authorization",
  "credential",
  "credentials",
]);
const KNOWN_SESSION_ENTRY_TYPES = new Set([
  "session",
  "message",
  "model_change",
  "thinking_level_change",
  "compaction",
  "branch_summary",
  "usage",
  "session_info",
  "custom",
  "custom_message",
  "context_edit",
  "label",
]);
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"];
const OMIT = Symbol("omit-projection-value");

export class DiagnosticProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DiagnosticProjectionError";
    this.code = code;
  }
}

class JsonNumberLexeme {
  constructor(lexeme) {
    this.lexeme = lexeme;
  }
}

function fail(code, message) {
  throw new DiagnosticProjectionError(code, message);
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof JsonNumberLexeme);
}

function boundedInteger(value, name, { min = 1, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("invalid-limit", `${name} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function normalizeLimits(options) {
  const limits = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const fallback = key === "maxLineBytes"
      ? Math.min(DEFAULT_LIMITS.maxLineBytes, options.maxInputBytes ?? DEFAULT_LIMITS.maxInputBytes)
      : DEFAULT_LIMITS[key];
    const value = options[key] ?? fallback;
    const min = key === "maxOutputBytes" ? 512 : 1;
    limits[key] = boundedInteger(value, key, { min, max: ABSOLUTE_LIMITS[key] });
  }
  if (limits.maxLineBytes > limits.maxInputBytes) {
    fail("invalid-limit", "maxLineBytes cannot exceed maxInputBytes.");
  }
  return limits;
}

function jsonStringLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
}

function canonicalDecimal(lexeme) {
  const match = lexeme.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;
  const negative = match[1] === "-";
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (digits.length === 0) return "0";

  let exponent;
  try {
    exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length);
  } catch {
    return null;
  }
  let trailingZeros = 0;
  while (digits.length > 1 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    trailingZeros++;
  }
  exponent += BigInt(trailingZeros);
  return `${negative ? "-" : "+"}${digits}e${exponent}`;
}

function exactNumberValue(value) {
  if (value.lexeme.length > 4_096) {
    fail("unsupported-number-precision", "A selected JSON number cannot be emitted without changing its value.");
  }
  const number = Number(value.lexeme);
  const emitted = JSON.stringify(number);
  if (!Number.isFinite(number) || emitted === undefined || canonicalDecimal(value.lexeme) !== canonicalDecimal(emitted)) {
    fail("unsupported-number-precision", "A selected JSON number cannot be emitted without changing its value.");
  }
  // JSON.stringify(-0) produces 0, so preserve the fail-closed rule for sign-sensitive zero.
  if (Object.is(number, -0)) {
    fail("unsupported-number-precision", "A selected JSON number cannot be emitted without changing its value.");
  }
  return number;
}

function parseLosslessJson(text) {
  let index = 0;
  let nodes = 0;

  const syntaxError = () => fail("malformed-json", "Input is not a complete JSON document.");
  const skipWhitespace = () => {
    while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\r" || text[index] === "\n")) index++;
  };

  function parseString() {
    if (text[index] !== '"') syntaxError();
    const start = index++;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index++;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          syntaxError();
        }
      }
      if (char === "\\") {
        index += 2;
      } else {
        index++;
      }
    }
    syntaxError();
  }

  function parseValue(depth) {
    skipWhitespace();
    if (depth > MAX_INPUT_DEPTH) fail("input-depth-limit", "JSON nesting exceeds the safe parser depth.");
    nodes++;
    if (nodes > MAX_INPUT_NODES) fail("input-node-limit", "JSON structure exceeds the safe parser node count.");
    const char = text[index];

    if (char === '"') return parseString();
    if (char === "{") {
      index++;
      skipWhitespace();
      const object = Object.create(null);
      if (text[index] === "}") {
        index++;
        return object;
      }
      while (index < text.length) {
        skipWhitespace();
        const key = parseString();
        skipWhitespace();
        if (text[index] !== ":") syntaxError();
        index++;
        const value = parseValue(depth + 1);
        Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
        skipWhitespace();
        if (text[index] === "}") {
          index++;
          return object;
        }
        if (text[index] !== ",") syntaxError();
        index++;
      }
      syntaxError();
    }
    if (char === "[") {
      index++;
      skipWhitespace();
      const array = [];
      if (text[index] === "]") {
        index++;
        return array;
      }
      while (index < text.length) {
        array.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === "]") {
          index++;
          return array;
        }
        if (text[index] !== ",") syntaxError();
        index++;
      }
      syntaxError();
    }
    if (text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    numberPattern.lastIndex = index;
    const numberMatch = numberPattern.exec(text);
    if (numberMatch) {
      index = numberPattern.lastIndex;
      return new JsonNumberLexeme(numberMatch[0]);
    }
    syntaxError();
  }

  const result = parseValue(0);
  skipWhitespace();
  if (index !== text.length) syntaxError();
  return result;
}

function decodeJsonPointer(pointer) {
  if (typeof pointer !== "string" || pointer.length === 0 || pointer.length > MAX_POINTER_LENGTH || !pointer.startsWith("/")) {
    fail("invalid-selector", "Each JSON Pointer must be a non-root pointer beginning with '/'.");
  }
  const segments = pointer.slice(1).split("/").map((segment) => {
    if (/~(?:[^01]|$)/.test(segment)) fail("invalid-selector", "JSON Pointer contains an invalid '~' escape.");
    return segment.replace(/~1/g, "/").replace(/~0/g, "~");
  });
  if (segments.some((segment) => isOpaqueKey(segment))) {
    fail("unsafe-selector", "JSON Pointer selects a blocked prototype or opaque field.");
  }
  return { pointer, segments };
}

function resolvePointer(root, pointer) {
  let value = root;
  for (const segment of pointer.segments) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return { found: false };
      const position = Number(segment);
      if (!Number.isSafeInteger(position) || position >= value.length) return { found: false };
      value = value[position];
      continue;
    }
    if (!isPlainRecord(value) || !Object.hasOwn(value, segment)) return { found: false };
    value = value[segment];
  }
  return { found: true, value };
}

function isOpaqueKey(key) {
  const lower = String(key).toLowerCase();
  const normalized = lower.replace(/[^a-z0-9]/g, "");
  return lower === "__proto__"
    || OPAQUE_KEYS.has(normalized)
    || ["signature", "encrypted", "ciphertext", "privatekey", "authorization"].some((part) => normalized.includes(part));
}

function validateSelectedNumbers(value, depth = 0, visited = { count: 0 }) {
  visited.count++;
  if (visited.count > MAX_INPUT_NODES) fail("input-node-limit", "Selected JSON structure exceeds the safe node count.");
  if (value instanceof JsonNumberLexeme) {
    exactNumberValue(value);
    return;
  }
  if (depth > MAX_INPUT_DEPTH) fail("input-depth-limit", "Selected JSON nesting exceeds the safe depth.");
  if (Array.isArray(value)) {
    for (const item of value) validateSelectedNumbers(item, depth + 1, visited);
  } else if (isPlainRecord(value)) {
    for (const key of Object.keys(value)) {
      if (!isOpaqueKey(key)) validateSelectedNumbers(value[key], depth + 1, visited);
    }
  }
}

function makeOmissions() {
  return {
    collectionItems: 0,
    objectFields: 0,
    depthValues: 0,
    nodeBudgetValues: 0,
    opaqueFields: 0,
    textCharacters: 0,
    metadataCharacters: 0,
  };
}

function clipText(value, state) {
  const available = state.textRemaining;
  let end = Math.min(value.length, available);
  if (end < value.length && end > 0) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  const output = value.slice(0, end);
  state.textRemaining -= end;
  state.omissions.textCharacters += value.length - end;
  return output;
}

function projectValue(value, state, depth = 0) {
  if (state.nodesRemaining <= 0) {
    state.omissions.nodeBudgetValues++;
    return OMIT;
  }
  state.nodesRemaining--;

  if (value instanceof JsonNumberLexeme) return exactNumberValue(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return clipText(value, state);

  if (depth >= state.maxDepth) {
    state.omissions.depthValues++;
    return OMIT;
  }

  if (Array.isArray(value)) {
    const output = [];
    const retained = Math.min(value.length, state.maxRows);
    for (let index = 0; index < retained; index++) {
      const child = projectValue(value[index], state, depth + 1);
      if (child !== OMIT) output.push(child);
    }
    state.omissions.collectionItems += value.length - retained;
    return output;
  }

  if (isPlainRecord(value)) {
    const output = Object.create(null);
    const keys = Object.keys(value);
    let retained = 0;
    for (const key of keys) {
      if (isOpaqueKey(key)) {
        state.omissions.opaqueFields++;
        continue;
      }
      if (retained >= state.maxRows) {
        state.omissions.objectFields++;
        continue;
      }
      retained++;
      const child = projectValue(value[key], state, depth + 1);
      if (child !== OMIT) Object.defineProperty(output, key, { value: child, enumerable: true, configurable: true, writable: true });
    }
    return output;
  }

  return OMIT;
}

function projectionState(limits, effective = {}) {
  return {
    maxRows: effective.maxRows ?? limits.maxRows,
    maxDepth: effective.maxDepth ?? limits.maxDepth,
    textRemaining: effective.maxTextChars ?? limits.maxTextChars,
    nodesRemaining: effective.maxNodes ?? 2_048,
    omissions: makeOmissions(),
  };
}

function openSource(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) fail("missing-file", "A source file path is required.");
  return (async () => {
    let resolved;
    let handle;
    try {
      resolved = await realpath(filePath);
      const readOnlyNonBlocking = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);
      handle = await open(resolved, readOnlyNonBlocking);
      const before = await handle.stat();
      if (!before.isFile()) {
        await handle.close();
        fail("not-regular-file", "The selected source is not a regular file.");
      }
      return { handle, resolved, before };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (error instanceof DiagnosticProjectionError) throw error;
      fail("file-read-failed", "The selected source could not be opened read-only.");
    }
  })();
}

function statChanged(before, after) {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function sourceIdentity(resolved, before) {
  return {
    path: resolved,
    device: String(before.dev),
    inode: String(before.ino),
    snapshotBytes: before.size,
    snapshotMtimeMs: before.mtimeMs,
    readOnly: true,
  };
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid-utf8", "Source bytes are not valid UTF-8.");
  }
}

function addIssue(coverage, line, code) {
  coverage.issueCount++;
  if (coverage.issues.length < MAX_ISSUES) coverage.issues.push({ line, code });
  else coverage.omittedIssues++;
  if (code === "malformed-json" || code === "invalid-entry" || code === "invalid-utf8" || code === "input-depth-limit" || code === "input-node-limit") {
    coverage.malformedCompleteLines++;
  }
}

function entryUsage(entry) {
  if (!isPlainRecord(entry)) return undefined;
  if (entry.type === "message") {
    if (!isPlainRecord(entry.message)) return undefined;
    return isPlainRecord(entry.message.usage) ? entry.message.usage : undefined;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") {
    return isPlainRecord(entry.usage) ? entry.usage : undefined;
  }
  return undefined;
}

function opaqueCount(value, depth = 0) {
  if (depth > MAX_INPUT_DEPTH) return 0;
  let count = 0;
  if (Array.isArray(value)) {
    for (const item of value) count += opaqueCount(item, depth + 1);
  } else if (isPlainRecord(value)) {
    for (const key of Object.keys(value)) {
      if (isOpaqueKey(key)) count++;
      else count += opaqueCount(value[key], depth + 1);
    }
  }
  return count;
}

function clipMetadata(value, maxLength, coverage) {
  if (typeof value !== "string") return undefined;
  const clipped = value.slice(0, maxLength);
  coverage.metadataCharactersOmitted += value.length - clipped.length;
  return clipped;
}

function textContentBlocks(message) {
  if (!isPlainRecord(message)) return [];
  const content = message.content;
  if (typeof content === "string") return [{ index: 0, text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (let index = 0; index < content.length; index++) {
    const block = content[index];
    if (isPlainRecord(block) && block.type === "text" && typeof block.text === "string") {
      blocks.push({ index, text: block.text });
    }
  }
  return blocks;
}

function toolCallBlocks(message) {
  if (!isPlainRecord(message) || !Array.isArray(message.content)) return [];
  const calls = [];
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index];
    if (isPlainRecord(block) && block.type === "toolCall") calls.push({ index, block });
  }
  return calls;
}

function candidateForEntry({ entry, line, mode, pointers, coverage, limits, candidateRows }) {
  if (!isPlainRecord(entry)) return;
  const type = typeof entry.type === "string" ? entry.type : "";
  if (!KNOWN_SESSION_ENTRY_TYPES.has(type)) coverage.unrecognizedEntryTypes++;
  if (type === "session") return;

  const source = { line, ...(typeof entry.id === "string" ? { entryId: clipMetadata(entry.id, 256, coverage) } : {}) };
  if (mode === "usage") {
    const usage = entryUsage(entry);
    if (!usage) return;
    coverage.matchedRows++;
    if (candidateRows.length < limits.maxRows) candidateRows.push({ source, kind: "usage", usage });
    return;
  }

  if (type !== "message" || !isPlainRecord(entry.message)) return;
  const message = entry.message;
  if (mode === "text") {
    if (message.role !== "user" && message.role !== "assistant") return;
    for (const block of textContentBlocks(message)) {
      coverage.matchedRows++;
      coverage.totalSelectedTextCharacters += block.text.length;
      if (candidateRows.length < limits.maxRows) {
        candidateRows.push({
          source: { ...source, contentIndex: block.index },
          kind: "text",
          role: message.role,
          text: block.text.slice(0, limits.maxTextChars),
          originalTextLength: block.text.length,
        });
      }
    }
    return;
  }

  if (mode === "toolCalls" && message.role === "assistant") {
    for (const { index, block } of toolCallBlocks(message)) {
      const argumentsValue = isPlainRecord(block.input) || Array.isArray(block.input)
        ? block.input
        : (isPlainRecord(block.arguments) || Array.isArray(block.arguments) ? block.arguments : undefined);
      const argumentSelections = pointers.map((pointer) => {
        const result = argumentsValue === undefined ? { found: false } : resolvePointer(argumentsValue, pointer);
        if (result.found) {
          coverage.toolArgumentSelectorMatches[pointer.pointer] = (coverage.toolArgumentSelectorMatches[pointer.pointer] ?? 0) + 1;
          validateSelectedNumbers(result.value);
        }
        return { pointer: pointer.pointer, ...(result.found ? { found: true, value: result.value } : { found: false }) };
      });
      coverage.matchedRows++;
      if (candidateRows.length < limits.maxRows) {
        candidateRows.push({
          source: { ...source, contentIndex: index },
          kind: "toolCall",
          ...(typeof block.toolCallId === "string" ? { toolCallId: clipMetadata(block.toolCallId, 256, coverage) } : typeof block.id === "string" ? { toolCallId: clipMetadata(block.id, 256, coverage) } : {}),
          ...(typeof block.toolName === "string" ? { toolName: clipMetadata(block.toolName, 512, coverage) } : typeof block.name === "string" ? { toolName: clipMetadata(block.name, 512, coverage) } : {}),
          argumentSelections,
        });
      }
    }
  }
}

function projectUsage(usage, state) {
  const output = Object.create(null);
  for (const key of USAGE_FIELDS) {
    if (Object.hasOwn(usage, key)) {
      const value = projectValue(usage[key], state);
      if (value !== OMIT) Object.defineProperty(output, key, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  if (Object.hasOwn(usage, "cost")) {
    if (isPlainRecord(usage.cost)) {
      const cost = Object.create(null);
      for (const key of COST_FIELDS) {
        if (Object.hasOwn(usage.cost, key)) {
          const value = projectValue(usage.cost[key], state);
          if (value !== OMIT) Object.defineProperty(cost, key, { value, enumerable: true, configurable: true, writable: true });
        }
      }
      if (Object.keys(cost).length) output.cost = cost;
    } else {
      const value = projectValue(usage.cost, state);
      if (value !== OMIT) output.cost = value;
    }
  }
  return output;
}

function materializeJournalRecords(candidateRows, mode, effectiveRows, limits, textBudget, coverage) {
  const displayed = candidateRows.slice(0, effectiveRows);
  const state = projectionState(limits, { maxTextChars: textBudget });
  const records = [];
  let displayedTextCharacters = 0;
  for (const candidate of displayed) {
    if (candidate.kind === "usage") {
      records.push({ source: candidate.source, usage: projectUsage(candidate.usage, state) });
    } else if (candidate.kind === "text") {
      const originalPrefix = candidate.text;
      const text = clipText(originalPrefix, state);
      displayedTextCharacters += text.length;
      records.push({ source: candidate.source, role: candidate.role, text });
    } else if (candidate.kind === "toolCall") {
      const record = { source: candidate.source };
      if (candidate.toolCallId !== undefined) record.toolCallId = candidate.toolCallId;
      if (candidate.toolName !== undefined) record.toolName = candidate.toolName;
      if (candidate.argumentSelections.length) {
        record.argumentSelections = candidate.argumentSelections.map((selection) => {
          if (!selection.found) return { pointer: selection.pointer, found: false };
          const value = projectValue(selection.value, state);
          return value === OMIT ? { pointer: selection.pointer, found: true, omitted: true } : { pointer: selection.pointer, found: true, value };
        });
      }
      records.push(record);
    }
  }

  if (mode === "text") {
    state.omissions.textCharacters += Math.max(0, coverage.totalSelectedTextCharacters - displayedTextCharacters - state.omissions.textCharacters);
  }
  const omittedRows = Math.max(0, coverage.matchedRows - records.length);
  return { records, state, displayedTextCharacters, omittedRows };
}

function finalizeJournalResult({ source, header, mode, fromLine, toLine, coverage, candidateRows, limits }) {
  let effectiveRows = Math.min(limits.maxRows, candidateRows.length);
  let textBudget = limits.maxTextChars;
  for (let attempt = 0; attempt < 32; attempt++) {
    const materialized = materializeJournalRecords(candidateRows, mode, effectiveRows, limits, textBudget, coverage);
    materialized.state.omissions.metadataCharacters = coverage.metadataCharactersOmitted;
    const result = {
      kind: "pi-session-diagnostic-projection-v1",
      mode,
      source,
      session: {
        id: typeof header.id === "string" ? header.id.slice(0, 256) : null,
        version: exactNumberValue(header.version),
      },
      records: materialized.records,
      coverage: {
        selectedRange: { fromLine, toLine, linesPresent: coverage.linesPresent, bytes: coverage.selectedRangeBytes },
        inputBytesRead: coverage.inputBytesRead,
        complete: coverage.complete,
        projectionComplete: coverage.unrecognizedEntryTypes === 0,
        malformedCompleteLines: coverage.malformedCompleteLines,
        partialFinalLine: coverage.partialFinalLine,
        sourceChangedDuringRead: coverage.sourceChangedDuringRead,
        unrecognizedEntryTypes: coverage.unrecognizedEntryTypes,
        matchedRows: coverage.matchedRows,
        displayedRows: materialized.records.length,
        omittedRows: materialized.omittedRows,
        opaqueFieldsOmitted: coverage.opaqueFieldsOmitted,
        metadataCharactersOmitted: coverage.metadataCharactersOmitted,
        textCharactersOmitted: materialized.state.omissions.textCharacters,
        toolArgumentSelectorMatches: coverage.toolArgumentSelectorMatches,
        issueCount: coverage.issueCount,
        omittedIssues: coverage.omittedIssues,
        issues: coverage.issues,
      },
      limits: { ...limits, effectiveRows, effectiveTextChars: textBudget },
      omissions: materialized.state.omissions,
      output: { bytes: 0, maxBytes: limits.maxOutputBytes },
    };
    let bytes = jsonStringLength(result);
    result.output.bytes = bytes;
    bytes = jsonStringLength(result);
    result.output.bytes = bytes;
    bytes = jsonStringLength(result);
    if (bytes <= limits.maxOutputBytes) return result;
    if (effectiveRows > 0) effectiveRows = Math.floor(effectiveRows / 2);
    else if (textBudget > 0) textBudget = Math.floor(textBudget / 2);
    else if (materialized.state.nodesRemaining < 2_048) {
      // The rows and text are already at their minima; report the bounded failure rather than emit oversize output.
      fail("output-too-large", "Projection metadata exceeds the configured output byte cap.");
    } else {
      fail("output-too-large", "Projection metadata exceeds the configured output byte cap.");
    }
  }
  fail("output-too-large", "Projection could not fit within the configured output byte cap.");
}

function supportedVersion(header) {
  if (!isPlainRecord(header) || header.type !== "session" || !(header.version instanceof JsonNumberLexeme)) {
    fail("invalid-session-header", "The first complete journal line is not a supported session header.");
  }
  const version = exactNumberValue(header.version);
  if (!Number.isInteger(version) || version < 1 || version > 3) {
    fail("unsupported-session-version", "Only Pi session journal versions 1, 2, and 3 are supported.");
  }
  return version;
}

export async function projectSessionJournal(options = {}) {
  const { filePath, mode = "usage", fromLine, toLine, toolArgumentPointers = [] } = options;
  if (!["usage", "toolCalls", "text"].includes(mode)) fail("invalid-mode", "Journal mode must be usage, toolCalls, or text.");
  if (!Number.isSafeInteger(fromLine) || !Number.isSafeInteger(toLine) || fromLine < 1 || toLine < fromLine || toLine > MAX_SESSION_LINE_NUMBER) {
    fail("invalid-range", "A finite 1-based fromLine/toLine range is required.");
  }
  if (toLine - fromLine + 1 > MAX_SESSION_RANGE_LINES) fail("invalid-range", "Selected journal range exceeds the line-count cap.");
  if (!Array.isArray(toolArgumentPointers)) fail("invalid-selector", "Tool argument selectors must be a list of JSON Pointers.");
  if (mode !== "toolCalls" && toolArgumentPointers.length > 0) fail("invalid-selector", "Tool argument selectors are only valid in toolCalls mode.");
  if (toolArgumentPointers.length > MAX_SELECTORS) fail("invalid-selector", `At most ${MAX_SELECTORS} tool argument selectors are allowed.`);
  const pointers = toolArgumentPointers.map(decodeJsonPointer);
  const limits = normalizeLimits(options);
  const opened = await openSource(filePath);
  const { handle, resolved, before } = opened;
  const source = sourceIdentity(resolved, before);
  const coverage = {
    complete: true,
    linesPresent: 0,
    selectedRangeBytes: 0,
    inputBytesRead: 0,
    malformedCompleteLines: 0,
    partialFinalLine: false,
    sourceChangedDuringRead: false,
    unrecognizedEntryTypes: 0,
    matchedRows: 0,
    opaqueFieldsOmitted: 0,
    metadataCharactersOmitted: 0,
    totalSelectedTextCharacters: 0,
    toolArgumentSelectorMatches: Object.create(null),
    issueCount: 0,
    omittedIssues: 0,
    issues: [],
  };
  const candidateRows = [];
  let header;
  let lineNumber = 1;
  let bytePosition = 0;
  let pending = Buffer.alloc(0);
  let stoppedAtRange = false;

  const processLine = (rawLine, currentLine, terminated) => {
    const selected = currentLine >= fromLine && currentLine <= toLine;
    if (selected) {
      coverage.linesPresent++;
      coverage.selectedRangeBytes += rawLine.length + (terminated ? 1 : 0);
    }
    if (currentLine === 1 && rawLine.length > limits.maxLineBytes) fail("invalid-session-header", "The session header exceeds the line-size cap.");
    if (selected) {
      if (!terminated) {
        coverage.partialFinalLine = true;
        coverage.complete = false;
        addIssue(coverage, currentLine, "partial-eof");
        return;
      }
      if (rawLine.length > limits.maxLineBytes) {
        coverage.complete = false;
        addIssue(coverage, currentLine, "line-too-large");
        return;
      }
    }
    if (currentLine !== 1 && !selected) return;
    if (!terminated && currentLine === 1) fail("invalid-session-header", "The session header is not newline-terminated.");
    let normalized = rawLine;
    if (normalized.length > 0 && normalized[normalized.length - 1] === 0x0d) normalized = normalized.subarray(0, normalized.length - 1);
    let parsed;
    try {
      parsed = parseLosslessJson(decodeUtf8(normalized));
    } catch (error) {
      if (currentLine === 1) fail("invalid-session-header", "The first journal line is not a valid session header.");
      if (selected) {
        coverage.complete = false;
        addIssue(coverage, currentLine, error instanceof DiagnosticProjectionError ? error.code : "malformed-json");
      }
      return;
    }
    if (currentLine === 1) {
      supportedVersion(parsed);
      header = parsed;
      return;
    }
    if (!selected) return;
    if (!isPlainRecord(parsed) || typeof parsed.type !== "string") {
      coverage.complete = false;
      addIssue(coverage, currentLine, "invalid-entry");
      return;
    }
    coverage.opaqueFieldsOmitted += opaqueCount(parsed);
    candidateForEntry({ entry: parsed, line: currentLine, mode, pointers, coverage, limits, candidateRows });
  };

  try {
    while (bytePosition < before.size && lineNumber <= toLine) {
      const remainingAdmission = limits.maxInputBytes - coverage.inputBytesRead;
      if (remainingAdmission <= 0) fail("input-too-large", "Selected journal range exceeds the input byte cap.");
      const length = Math.min(IO_CHUNK_BYTES, before.size - bytePosition, remainingAdmission);
      const chunk = Buffer.allocUnsafe(length);
      let bytesRead;
      try {
        ({ bytesRead } = await handle.read(chunk, 0, length, bytePosition));
      } catch {
        fail("file-read-failed", "The selected journal could not be read.");
      }
      if (bytesRead === 0) break;
      bytePosition += bytesRead;
      coverage.inputBytesRead += bytesRead;
      const data = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let cursor = 0;
      while (lineNumber <= toLine) {
        const newline = data.indexOf(0x0a, cursor);
        if (newline < 0) break;
        const rawLine = data.subarray(cursor, newline);
        processLine(rawLine, lineNumber, true);
        lineNumber++;
        cursor = newline + 1;
      }
      if (lineNumber > toLine) {
        stoppedAtRange = true;
        pending = Buffer.alloc(0);
        break;
      }
      pending = Buffer.from(data.subarray(cursor));
      if (pending.length > limits.maxLineBytes && lineNumber === 1) fail("invalid-session-header", "The session header exceeds the line-size cap.");
      if (coverage.inputBytesRead >= limits.maxInputBytes && bytePosition < before.size && lineNumber <= toLine) {
        fail("input-too-large", "Selected journal range exceeds the input byte cap.");
      }
    }

    if (!stoppedAtRange && lineNumber <= toLine && pending.length > 0 && bytePosition >= before.size) {
      processLine(pending, lineNumber, false);
      lineNumber++;
    }
    if (!header) fail("invalid-session-header", "The session header is missing or incomplete.");
    const linesExpected = toLine - fromLine + 1;
    const missingLines = Math.max(0, linesExpected - coverage.linesPresent);
    if (missingLines > 0) {
      coverage.complete = false;
      addIssue(coverage, Math.min(toLine, lineNumber), "range-beyond-eof");
    }
    const after = await handle.stat();
    coverage.sourceChangedDuringRead = statChanged(before, after);
    if (coverage.sourceChangedDuringRead) coverage.complete = false;

    for (const pointer of pointers) {
      if ((coverage.toolArgumentSelectorMatches[pointer.pointer] ?? 0) === 0) {
        fail("missing-selector", `Tool argument selector did not match any selected tool call: ${pointer.pointer}`);
      }
    }
    source.bytesRead = coverage.inputBytesRead;
    source.changedDuringRead = coverage.sourceChangedDuringRead;
    if (typeof header.id === "string" && header.id.length > 256) coverage.metadataCharactersOmitted += header.id.length - 256;
    const result = finalizeJournalResult({ source, header, mode, fromLine, toLine, coverage, candidateRows, limits });
    return result;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function validatePointerList(pointers) {
  if (!Array.isArray(pointers) || pointers.length === 0) fail("missing-selector", "At least one explicit JSON Pointer is required.");
  if (pointers.length > MAX_SELECTORS) fail("invalid-selector", `At most ${MAX_SELECTORS} JSON Pointers are allowed.`);
  const decoded = pointers.map(decodeJsonPointer);
  const seen = new Set();
  for (const pointer of decoded) {
    if (seen.has(pointer.pointer)) fail("invalid-selector", "Duplicate JSON Pointers are not allowed.");
    seen.add(pointer.pointer);
  }
  return decoded;
}

async function readAdmittedJsonFile(filePath, maxInputBytes) {
  const opened = await openSource(filePath);
  const { handle, resolved, before } = opened;
  try {
    if (before.size > maxInputBytes) fail("input-too-large", "JSON document exceeds the input byte cap; no partial parse was attempted.");
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) fail("source-changed-during-read", "JSON source changed during admission; no projection was returned.");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (statChanged(before, after)) fail("source-changed-during-read", "JSON source changed during admission; no projection was returned.");
    const source = sourceIdentity(resolved, before);
    source.bytesRead = offset;
    source.changedDuringRead = false;
    return { source, text: decodeUtf8(buffer) };
  } catch (error) {
    if (error instanceof DiagnosticProjectionError) throw error;
    fail("file-read-failed", "The selected JSON source could not be read completely.");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function finalizeJsonResult({ source, selected, limits, effectiveRows, effectiveTextChars, maxNodes }) {
  const state = projectionState(limits, { maxRows: effectiveRows, maxTextChars: effectiveTextChars, maxNodes });
  const projected = [];
  for (const item of selected) {
    const value = projectValue(item.value, state);
    projected.push({ pointer: item.pointer, ...(value === OMIT ? { omitted: true } : { value }) });
  }
  const result = {
    kind: "pi-json-diagnostic-projection-v1",
    source,
    selected: projected,
    coverage: { complete: true, selectorCount: projected.length },
    limits: { ...limits, effectiveRows, effectiveTextChars, effectiveNodes: maxNodes },
    omissions: state.omissions,
    output: { bytes: 0, maxBytes: limits.maxOutputBytes },
  };
  let bytes = jsonStringLength(result);
  result.output.bytes = bytes;
  bytes = jsonStringLength(result);
  result.output.bytes = bytes;
  bytes = jsonStringLength(result);
  return { result, bytes };
}

export async function projectJsonArtifact(options = {}) {
  const { filePath, pointers: rawPointers } = options;
  const pointers = validatePointerList(rawPointers);
  const limits = normalizeLimits(options);
  const { source, text } = await readAdmittedJsonFile(filePath, limits.maxInputBytes);
  const root = parseLosslessJson(text);
  const selected = [];
  for (const pointer of pointers) {
    const resolved = resolvePointer(root, pointer);
    if (!resolved.found) fail("missing-selector", `JSON Pointer did not match the selected document: ${pointer.pointer}`);
    validateSelectedNumbers(resolved.value);
    selected.push({ pointer: pointer.pointer, value: resolved.value });
  }

  let effectiveRows = limits.maxRows;
  let effectiveTextChars = limits.maxTextChars;
  let maxNodes = 2_048;
  for (let attempt = 0; attempt < 48; attempt++) {
    const finalized = finalizeJsonResult({ source, selected, limits, effectiveRows, effectiveTextChars, maxNodes });
    if (finalized.bytes <= limits.maxOutputBytes) {
      finalized.result.output.bytes = finalized.bytes;
      const exactBytes = jsonStringLength(finalized.result);
      finalized.result.output.bytes = exactBytes;
      return finalized.result;
    }
    if (maxNodes > 16) maxNodes = Math.floor(maxNodes / 2);
    else if (effectiveRows > 1) effectiveRows = Math.floor(effectiveRows / 2);
    else if (effectiveTextChars > 0) effectiveTextChars = Math.floor(effectiveTextChars / 2);
    else fail("output-too-large", "Projection metadata exceeds the configured output byte cap.");
  }
  fail("output-too-large", "Projection could not fit within the configured output byte cap.");
}
