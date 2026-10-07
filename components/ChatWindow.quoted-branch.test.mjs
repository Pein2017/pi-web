import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import test from "node:test";
import ts from "typescript";

test("offers compact quoting controls and sends branch questions through the main chat", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

  assert.match(chatSource, /onPointerUp=\{captureQuotedSelection\}/);
  assert.match(chatSource, /closest<HTMLElement>\("\[data-message-role=/);
  assert.match(chatSource, /chatInputRef\?\.current\?\.insertText\(buildQuotedSelection/);
  assert.match(chatSource, /onAskInNewChat\([\s\S]*?sourceSessionId,[\s\S]*?quotedSelection\.sourceEntryId/);
  assert.match(shellSource, /type: "fork_branch"/);
  assert.match(shellSource, /initialPrompt=\{pendingQuotePrompt\?\.sessionId === selectedSession\?\.id/);
  assert.equal((shellSource.match(/<ChatWindow\b/g) ?? []).length, 1);
  assert.match(chatSource, /onInitialPromptConsumed\?\.\(\);\s*void handleSend\(initialPrompt\)/);
  assert.match(chatSource, /role=\{quoteInputOpen \? "dialog" : "toolbar"\}/);
});

test("quote-to-new-chat reuses the forked session skill catalog and loader", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const demoChatSource = await readFile(new URL("../demo/components/ChatWindow.tsx", import.meta.url), "utf8");
  const mainInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const demoInputSource = await readFile(new URL("../demo/components/ChatInput.tsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const hookText = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  const hookSource = ts.createSourceFile("useAgentSession.ts", hookText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  for (const inputSource of [mainInputSource, demoInputSource]) {
    assert.match(inputSource, /const slashQuery = !compact &&/);
  }
  for (const source of [chatSource, demoChatSource]) {
    const compactInput = source.match(/<ChatInput\s+ref=\{quoteChatInputRef\}\s+compact[\s\S]*?\/>/)?.[0];
    assert.ok(compactInput, "expected compact quote ChatInput");
    assert.match(compactInput, /slashCommands=\{slashCommands\}/);
    assert.match(compactInput, /slashCommandsLoading=\{slashCommandsLoading\}/);
    assert.match(compactInput, /onLoadSlashCommands=\{loadSlashCommands\}/);
    assert.doesNotMatch(compactInput, /\bcwd=/, "compact quote input must not enable @ file completion");
  }

  assert.match(shellSource, /sendAgentCommand<\{ newSessionId\?: string \}>\(sourceSessionId,/);
  assert.match(shellSource, /type: "fork_branch",\s*entryId: sourceEntryId/);
  assert.match(hookText, /const sid = sessionIdRef\.current \?\? await ensureNewSession\(\)/);
  assert.match(hookText, /sendAgentCommand<SlashCommandsResponse>\(sid, \{ type: "get_commands" \}\)/);

  function findRequestCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(hookSource) === "requestSlashCommands") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findRequestCallback);
  }
  const callback = findRequestCallback(hookSource);
  assert.ok(callback, "expected useAgentSession get_commands callback");

  const catalog = [
    { name: "skill:quoted", source: "skill", description: "Fork-context skill" },
    { name: "skill:unrelated", source: "skill", description: "Another skill" },
  ];
  const calls = [];
  let storedCommands = [];
  let ensureNewSessionCalls = 0;
  // Install the real callback closure over a source-session command fixture.
  const fixtureRequest = new Script(ts.transpileModule(`(${callback.getText(hookSource)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext({
    sessionIdRef: { current: "source-session" },
    ensureNewSession: async () => { ensureNewSessionCalls += 1; return "unexpected-new-session"; },
    slashCommandsGenerationRef: { current: 0 },
    slashCommandsLoadRef: { current: null },
    replaceSlashCommands(commands) { storedCommands = commands; },
    setSlashCommandsLoading() {},
    sendAgentCommand: async (sessionId, command) => {
      calls.push({ sessionId, command });
      return { commands: catalog };
    },
    console,
  });
  const loaded = await fixtureRequest();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "source-session");
  assert.equal(calls[0].command.type, "get_commands");
  assert.equal(ensureNewSessionCalls, 0, "the quote branch uses its source session, not unrelated new-session resources");
  assert.deepEqual(loaded, catalog);
  assert.deepEqual(storedCommands, catalog);
});

test("keeps the selection toolbar above the session sidebar", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

  const toolbar = chatSource.match(/role=\{quoteInputOpen \? "dialog" : "toolbar"\}[\s\S]*?zIndex:\s*(\d+)/);
  const sidebar = shellSource.match(/id="session-sidebar"[\s\S]*?zIndex:\s*(\d+)/);

  assert.ok(toolbar, "expected quote toolbar z-index");
  assert.ok(sidebar, "expected session sidebar z-index");
  assert.ok(
    Number(toolbar[1]) > Number(sidebar[1]),
    `quote toolbar z-index ${toolbar[1]} should be above session sidebar z-index ${sidebar[1]}`,
  );
});
