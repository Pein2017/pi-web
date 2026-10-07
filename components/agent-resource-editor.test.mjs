import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { normalizeAgentResourceDraft } = await createJiti(import.meta.url).import("./agent-resource-editor.ts");

test("resource editor preserves empty selections and explicitly resets All rather than omitting fields", () => {
  const draft = { name: "coord-builder", skillNames: [" shared-memory ", "", "shared-memory"], extensionPaths: [], mcpServers: ["codegraph", " "], mcpTools: undefined };
  const normalized = normalizeAgentResourceDraft(draft);
  assert.deepEqual(normalized, { name: "coord-builder", skillNames: ["shared-memory"], extensionPaths: [], mcpServers: ["codegraph"], mcpTools: null });
  assert.deepEqual(draft.extensionPaths, []);
  assert.equal(normalizeAgentResourceDraft({}).skillNames, null);
});
