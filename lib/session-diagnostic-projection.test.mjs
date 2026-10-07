import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import {
  DiagnosticProjectionError,
  projectJsonArtifact,
  projectSessionJournal,
} from "./session-diagnostic-projection.mjs";

const tempDirs = new Set();

async function tempFile(contents, suffix = ".jsonl") {
  const dir = await mkdtemp(join(tmpdir(), "pi-diagnostics-test-"));
  tempDirs.add(dir);
  const filePath = join(dir, `fixture${suffix}`);
  await writeFile(filePath, contents);
  return { dir, filePath };
}

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

function sessionLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function assistantUsage(id, input = 7) {
  return {
    type: "message",
    id,
    parentId: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "later answer" }],
      usage: {
        input,
        output: 2,
        cacheRead: 3,
        cacheWrite: 0,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      },
    },
  };
}

async function projectJournal(filePath, overrides = {}) {
  return projectSessionJournal({
    filePath,
    mode: "usage",
    fromLine: 1,
    toLine: 10,
    ...overrides,
  });
}

test("projects later usage after >50KB opaque data without emitting the payload or mutating the source", async () => {
  const signature = "OPAQUE_SIGNATURE_SENTINEL_" + "x".repeat(60 * 1024);
  const source = [
    sessionLine({ type: "session", version: 3, id: "session-1", cwd: "/not-emitted" }),
    sessionLine({ type: "compaction", id: "compact-1", details: { signature, encryptedContent: "ENCRYPTED_SENTINEL" } }),
    sessionLine(assistantUsage("usage-1", 29)),
  ].join("");
  const { filePath } = await tempFile(source);
  const beforeBytes = await readFile(filePath);
  const beforeStat = await stat(filePath);

  const result = await projectJournal(filePath, { toLine: 3 });
  const serialized = JSON.stringify(result);
  const afterBytes = await readFile(filePath);
  const afterStat = await stat(filePath);

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].source.line, 3);
  assert.equal(result.records[0].source.entryId, "usage-1");
  assert.equal(result.records[0].usage.input, 29);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.opaqueFieldsOmitted, 2);
  assert.doesNotMatch(serialized, /OPAQUE_SIGNATURE_SENTINEL|ENCRYPTED_SENTINEL|not-emitted/);
  assert.deepEqual(afterBytes, beforeBytes);
  assert.equal(afterStat.size, beforeStat.size);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  assert.equal(result.source.path, filePath);
  assert.equal(result.source.snapshotBytes, Buffer.byteLength(source));
});

test("parses the whole selected range before clipping output rows", async () => {
  const entries = [{ type: "session", version: 3, id: "many" }];
  for (let index = 0; index < 25; index++) entries.push({ type: "usage", id: `u-${index}`, usage: { input: index } });
  const { filePath } = await tempFile(entries.map(sessionLine).join(""));

  const result = await projectJournal(filePath, { toLine: entries.length, maxRows: 2 });

  assert.equal(result.coverage.matchedRows, 25);
  assert.equal(result.coverage.displayedRows, 2);
  assert.equal(result.coverage.omittedRows, 23);
  assert.equal(result.records[0].source.entryId, "u-0");
  assert.equal(result.records[1].source.entryId, "u-1");
});

test("discloses malformed complete lines and a partial final line while retaining later valid usage", async () => {
  const source = [
    sessionLine({ type: "session", version: 3, id: "broken" }),
    "{malformed complete line}\n",
    sessionLine(assistantUsage("valid-after-error", 11)),
    '{"type":"message","id":"partial"}',
  ].join("");
  const { filePath } = await tempFile(source);

  const result = await projectJournal(filePath, { toLine: 4 });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].source.line, 3);
  assert.equal(result.records[0].usage.input, 11);
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.issues.some((issue) => issue.line === 2 && issue.code === "malformed-json"));
  assert.ok(result.coverage.issues.some((issue) => issue.line === 4 && issue.code === "partial-eof"));
  assert.equal(result.coverage.malformedCompleteLines, 1);
  assert.equal(result.coverage.partialFinalLine, true);
});

test("rejects unsupported journal versions before projecting entries", async () => {
  const { filePath } = await tempFile([
    sessionLine({ type: "session", version: 99, id: "future" }),
    sessionLine(assistantUsage("must-not-project")),
  ].join(""));

  await assert.rejects(projectJournal(filePath, { toLine: 2 }), (error) => {
    assert.ok(error instanceof DiagnosticProjectionError);
    assert.equal(error.code, "unsupported-session-version");
    return true;
  });
});

test("bounds text and tool-call arguments; defaults omit arguments and opaque fields", async () => {
  const { filePath } = await tempFile([
    sessionLine({ type: "session", version: 3, id: "display" }),
    sessionLine({
      type: "message",
      id: "display-entry",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "VISIBLE_TEXT_" + "a".repeat(200) },
          { type: "thinking", thinking: "PRIVATE_REASONING_SENTINEL" },
          { type: "toolCall", toolCallId: "call-1", toolName: "read", input: { file_path: "/tmp/example.txt", api_key: "SECRET_SENTINEL" } },
          { type: "image", data: "IMAGE_SENTINEL" },
        ],
      },
    }),
  ].join(""));

  const text = await projectSessionJournal({ filePath, mode: "text", fromLine: 1, toLine: 2, maxTextChars: 12 });
  assert.equal(text.records.length, 1);
  assert.equal(text.records[0].text.length, 12);
  assert.equal(text.coverage.textCharactersOmitted, 201);
  assert.doesNotMatch(JSON.stringify(text), /PRIVATE_REASONING_SENTINEL|IMAGE_SENTINEL/);

  const calls = await projectSessionJournal({ filePath, mode: "toolCalls", fromLine: 1, toLine: 2 });
  assert.equal(calls.records.length, 1);
  assert.equal(calls.records[0].toolName, "read");
  assert.equal(calls.records[0].argumentSelections, undefined);
  assert.doesNotMatch(JSON.stringify(calls), /example\.txt|SECRET_SENTINEL/);

  const selected = await projectSessionJournal({
    filePath,
    mode: "toolCalls",
    fromLine: 1,
    toLine: 2,
    toolArgumentPointers: ["/file_path"],
    maxTextChars: 8,
  });
  assert.equal(selected.records[0].argumentSelections[0].value, "/tmp/exa");
  await assert.rejects(projectSessionJournal({
    filePath,
    mode: "toolCalls",
    fromLine: 1,
    toLine: 2,
    toolArgumentPointers: ["/api_key"],
  }), { code: "unsafe-selector" });
});

test("rejects missing and hostile JSON Pointers without prototype effects", async () => {
  const { filePath } = await tempFile('{"safe":{"value":1},"__proto__":{"polluted":true}}', ".json");

  await assert.rejects(projectJsonArtifact({ filePath, pointers: ["/missing"] }), { code: "missing-selector" });
  await assert.rejects(projectJsonArtifact({ filePath, pointers: ["/__proto__/polluted"] }), { code: "unsafe-selector" });
  await assert.rejects(projectJsonArtifact({ filePath, pointers: ["/constructor/prototype"] }), { code: "unsafe-selector" });
  assert.equal({}.polluted, undefined);
});

test("preserves exact numeric values or rejects unsupported precision before output", async () => {
  const { filePath } = await tempFile(
    '{"unsafe":9007199254740993,"longDecimal":0.123456789012345678901,"expEquivalent":1e3,"decimalEquivalent":1000.0000,"zeroEquivalent":0e12,"negativeZero":-0e12}',
    ".json",
  );

  await assert.rejects(projectJsonArtifact({ filePath, pointers: ["/unsafe"] }), { code: "unsupported-number-precision" });
  await assert.rejects(projectJsonArtifact({ filePath, pointers: ["/longDecimal"] }), { code: "unsupported-number-precision" });

  await assert.rejects(projectJsonArtifact({ filePath, pointers: ["/negativeZero"] }), { code: "unsupported-number-precision" });
  const result = await projectJsonArtifact({ filePath, pointers: ["/expEquivalent", "/decimalEquivalent", "/zeroEquivalent"] });
  assert.deepEqual(result.selected.map(({ value }) => value), [1000, 1000, 0]);
  assert.ok(result.selected.every(({ value }) => typeof value === "number"));
});

test("omits opaque JSON fields and discloses nesting clipped by the depth cap", async () => {
  const opaque = await tempFile(
    '{"report":{"ok":true,"signature":"SIGNATURE_SECRET","encryptedContent":"CIPHERTEXT_SECRET","nested":{"value":7}}}',
    ".json",
  );
  const projected = await projectJsonArtifact({ filePath: opaque.filePath, pointers: ["/report"] });
  const text = JSON.stringify(projected);
  assert.doesNotMatch(text, /SIGNATURE_SECRET|CIPHERTEXT_SECRET/);
  assert.equal(projected.omissions.opaqueFields, 2);
  assert.equal(projected.selected[0].value.ok, true);

  const deep = await tempFile('{"outer":{"inner":{"value":"omitted"}}}', ".json");
  const shallow = await projectJsonArtifact({ filePath: deep.filePath, pointers: ["/outer"], maxDepth: 1 });
  assert.deepEqual(shallow.selected[0].value, Object.create(null));
  assert.equal(shallow.omissions.depthValues, 1);
});

test("fails JSON admission before partial parsing and keeps projected output within its cap", async () => {
  const oversized = await tempFile(JSON.stringify({ value: "x".repeat(200) }), ".json");
  await assert.rejects(projectJsonArtifact({ filePath: oversized.filePath, pointers: ["/value"], maxInputBytes: 64 }), { code: "input-too-large" });

  const large = await tempFile(JSON.stringify({ values: Array.from({ length: 60 }, (_, index) => ({ index, text: "t".repeat(1000) })) }), ".json");
  const result = await projectJsonArtifact({
    filePath: large.filePath,
    pointers: ["/values"],
    maxOutputBytes: 4096,
    maxRows: 100,
    maxTextChars: 16000,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
  assert.ok(result.omissions.collectionItems + result.omissions.textCharacters > 0);
});

test("reports JSON file identity and clips a finite journal line range", async () => {
  const { filePath } = await tempFile([
    sessionLine({ type: "session", version: 3, id: "range" }),
    sessionLine({ type: "usage", id: "one", usage: { input: 1 } }),
    sessionLine({ type: "usage", id: "two", usage: { input: 2 } }),
    sessionLine({ type: "usage", id: "three", usage: { input: 3 } }),
  ].join(""));

  const result = await projectJournal(filePath, { fromLine: 2, toLine: 3 });
  assert.deepEqual(result.records.map(({ source }) => source.line), [2, 3]);
  assert.deepEqual(result.records.map(({ source }) => source.entryId), ["one", "two"]);
  assert.deepEqual(result.coverage.selectedRange, {
    fromLine: 2,
    toLine: 3,
    linesPresent: 2,
    bytes: Buffer.byteLength(sessionLine({ type: "usage", id: "one", usage: { input: 1 } }) + sessionLine({ type: "usage", id: "two", usage: { input: 2 } })),
  });
  assert.equal(result.source.readOnly, true);
  assert.ok(result.source.device && result.source.inode);

  const cli = new URL("../bin/pi-diagnostics.mjs", import.meta.url);
  const resultCli = spawnSync(process.execPath, [cli.pathname, "journal", "--file", filePath, "--from-line", "2", "--to-line", "3"], { encoding: "utf8" });
  assert.equal(resultCli.status, 0, resultCli.stderr);
  assert.match(resultCli.stdout, /"entryId":"one"/);
});

test("CLI exposes JSON projections and rejects a missing selector", async () => {
  const { filePath } = await tempFile('{"metrics":{"input":7}}', ".json");
  const cli = new URL("../bin/pi-diagnostics.mjs", import.meta.url);
  const good = spawnSync(process.execPath, [cli.pathname, "json", "--file", filePath, "--pointer", "/metrics/input"], { encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /"value":7/);

  const missing = spawnSync(process.execPath, [cli.pathname, "json", "--file", filePath], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /pointer/i);
});
