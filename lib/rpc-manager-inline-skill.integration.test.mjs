import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Match Pi Web's runtime identity: AgentSessionWrapper.reload() refreshes the
// SettingsManager project-trust state from getAgentDir(). Isolate that profile
// before loading the SDK or Web modules so the fixture cannot inherit a host
// profile (or a trusted parent checkout) from the test runner.
const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedProfileRoot = await mkdtemp(join(tmpdir(), "pi-web-inline-skill-profile-"));
const isolatedAgentDir = join(isolatedProfileRoot, "agent");
await mkdir(isolatedAgentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(async () => {
  if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
  await rm(isolatedProfileRoot, { recursive: true, force: true });
});

const { fauxAssistantMessage, fauxProvider, fauxText } = await import("@earendil-works/pi-ai");
const {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { createInlineSkillContextExtension } = await jiti.import("./inline-skill-context.ts");
const { projectTrustReloadOptions } = await jiti.import("./project-trust.ts");

const PROVIDER = "inline-skill-test-provider";
const MODEL = "inline-skill-test-model";
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-inline-skill-rpc-"));
  const cwd = join(root, "project");
  const agentDir = isolatedAgentDir;
  const sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  return {
    root,
    cwd,
    agentDir,
    sessionDir,
    skillPath(name) {
      return join(cwd, ".agents", "skills", name, "SKILL.md");
    },
    async writeSkill(name, body, { disabled = false } = {}) {
      const path = this.skillPath(name);
      await mkdir(join(cwd, ".agents", "skills", name), { recursive: true });
      await writeFile(path, `---\nname: ${name}\ndescription: ${name} test skill\n${disabled ? "disable-model-invocation: true\n" : ""}---\n${body}\n`);
      return path;
    },
  };
}

async function createWrappedSession(f, {
  trusted = true,
  enableInlineSkillExpansion = true,
  sessionManager = SessionManager.inMemory(f.cwd),
  extensionFactories = [],
  settings = { images: { autoResize: false } },
  unavailableAgentMethod,
} = {}) {
  assert.equal(getAgentDir(), f.agentDir, "the wrapper and resource loader must share the isolated agent profile");
  new ProjectTrustStore(f.agentDir).set(f.cwd, trusted);
  const faux = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(f.agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory(settings);
  const trustReloadOptions = projectTrustReloadOptions(f.cwd, f.agentDir);
  const loadedExtensionFactories = [
    ...(enableInlineSkillExpansion ? [createInlineSkillContextExtension()] : []),
    ...extensionFactories,
  ];
  const services = await createAgentSessionServices({
    cwd: f.cwd,
    agentDir: f.agentDir,
    modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      extensionFactories: loadedExtensionFactories,
      noExtensions: loadedExtensionFactories.length === 0,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model: faux.getModel(MODEL),
    tools: [],
    thinkingLevel: "off",
  });
  const originalAgentMethods = {
    prompt: session.agent.prompt,
    steer: session.agent.steer,
    followUp: session.agent.followUp,
  };
  if (unavailableAgentMethod) session.agent[unavailableAgentMethod] = undefined;
  const wrapper = new AgentSessionWrapper(session, { enableInlineSkillExpansion });
  wrapper.start();
  wrapper.beginExtensionBinding();
  return { faux, modelRuntime, services, session, wrapper, originalAgentMethods };
}

function textContent(message) {
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function userMessages(context) {
  return context.messages.filter((message) => message.role === "user");
}

function storedSkillContext(requestId, skillPath, baseDir, body, name = "alpha") {
  return {
    version: 1,
    requestId,
    skills: [{ name, filePath: skillPath, baseDir, body }],
  };
}

function appendUser(sessionManager, text, inlineSkillContext) {
  return sessionManager.appendMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
    ...(inlineSkillContext ? { piWeb: { inlineSkillContext } } : {}),
  });
}

async function sendPrompt(bundle, message, images) {
  await bundle.wrapper.send({ type: "prompt", message, ...(images ? { images } : {}) });
  await bundle.session.waitForIdle();
}

async function waitForQueuedMessage(getMessages, expected) {
  const deadline = Date.now() + 2_000;
  while (!getMessages().includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for queued message: ${expected}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function closeBundle(bundle) {
  await bundle.wrapper.shutdown();
}

test("prompt, steering, and follow-up send raw text plus separate selected-skill context", async (t) => {
  const f = await fixture(t);
  await f.writeSkill("alpha", "ALPHA_BODY");
  await f.writeSkill("beta", "BETA_BODY");
  await f.writeSkill("gamma", "GAMMA_BODY");
  const bundle = await createWrappedSession(f);
  t.after(() => closeBundle(bundle));
  assert.deepEqual(bundle.services.resourceLoader.getSkills().skills.map((skill) => skill.name), ["alpha", "beta", "gamma"]);

  let startFirst;
  const firstStarted = new Promise((resolve) => { startFirst = resolve; });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const contexts = [];
  bundle.faux.setResponses([
    async (context) => {
      contexts.push(structuredClone(context));
      startFirst();
      await firstGate;
      return fauxAssistantMessage([fauxText("first done")]);
    },
    (context) => {
      contexts.push(structuredClone(context));
      return fauxAssistantMessage([fauxText("steer done")]);
    },
    (context) => {
      contexts.push(structuredClone(context));
      return fauxAssistantMessage([fauxText("follow-up done")]);
    },
  ]);

  await bundle.wrapper.send({
    type: "prompt",
    message: "Start with $alpha and keep $unknown literal.",
    images: [{ type: "image", mimeType: "image/png", data: ONE_PIXEL_PNG }],
  });
  await firstStarted;
  await bundle.wrapper.send({
    type: "steer",
    message: "Steer with $beta.",
    images: [{ type: "image", mimeType: "image/png", data: ONE_PIXEL_PNG }],
  });
  await bundle.wrapper.send({
    type: "follow_up",
    message: "Follow up with $gamma.",
    images: [{ type: "image", mimeType: "image/png", data: ONE_PIXEL_PNG }],
  });
  releaseFirst();
  await bundle.session.waitForIdle();

  assert.equal(contexts.length, 3);
  const firstUser = userMessages(contexts[0])[0];
  const firstText = textContent(firstUser);
  assert.match(firstText, /Start with \$alpha and keep \$unknown literal\./);
  assert.doesNotMatch(firstText, /ALPHA_BODY/);
  assert.match(firstText, /\$unknown/);
  assert.match(JSON.stringify(contexts[0].messages), /ALPHA_BODY/);
  assert.equal(firstUser.content.filter((block) => block.type === "image").length, 1);
  assert.equal(firstUser.content.find((block) => block.type === "image").data, ONE_PIXEL_PNG);

  const steerUserMessages = userMessages(contexts[1]);
  const rawSteer = steerUserMessages.find((message) => textContent(message) === "Steer with $beta.");
  assert.ok(rawSteer, "the raw steer remains a distinct user message");
  assert.doesNotMatch(textContent(rawSteer), /BETA_BODY/);
  assert.ok(steerUserMessages.some((message) => message !== rawSteer && textContent(message).includes("BETA_BODY")));
  assert.equal(rawSteer.content.find((block) => block.type === "image").data, ONE_PIXEL_PNG);
  const followUserMessages = userMessages(contexts[2]);
  const rawFollowUp = followUserMessages.find((message) => textContent(message) === "Follow up with $gamma.");
  assert.ok(rawFollowUp, "the raw follow-up remains a distinct user message");
  assert.doesNotMatch(textContent(rawFollowUp), /GAMMA_BODY/);
  assert.ok(followUserMessages.some((message) => message !== rawFollowUp && textContent(message).includes("GAMMA_BODY")));
  assert.equal(rawFollowUp.content.find((block) => block.type === "image").data, ONE_PIXEL_PNG);

  const userEntry = bundle.session.sessionManager.getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  assert.equal(textContent(userEntry.message), "Start with $alpha and keep $unknown literal.");
  assert.equal(userEntry.message.piWeb.inlineSkillContext.skills[0].body, "ALPHA_BODY");
  assert.ok(contexts.every((context) => context.messages.every((message) => !Object.hasOwn(message, "piWeb"))));
});

test("identical queued text keeps each steer/follow-up snapshot attached to its own SDK message", async (t) => {
  const f = await fixture(t);
  const skillPath = await f.writeSkill("alpha", "QUEUED_SNAPSHOT_V1");
  const bundle = await createWrappedSession(f);
  t.after(() => closeBundle(bundle));
  const raw = "Use $alpha for this queued request.";
  const providerContexts = [];
  let startFirst;
  const firstStarted = new Promise((resolve) => { startFirst = resolve; });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  bundle.faux.setResponses([
    async (context) => {
      providerContexts.push(structuredClone(context));
      startFirst();
      await firstGate;
      return fauxAssistantMessage([fauxText("gate complete")]);
    },
    (context) => {
      providerContexts.push(structuredClone(context));
      return fauxAssistantMessage([fauxText("steer complete")]);
    },
    (context) => {
      providerContexts.push(structuredClone(context));
      return fauxAssistantMessage([fauxText("follow-up complete")]);
    },
  ]);

  await bundle.wrapper.send({ type: "prompt", message: "Start the gated run." });
  await firstStarted;
  await bundle.wrapper.send({ type: "steer", message: raw });
  await writeFile(skillPath, "---\nname: alpha\ndescription: alpha test skill\n---\nQUEUED_SNAPSHOT_V2\n");
  await bundle.wrapper.send({ type: "follow_up", message: raw });
  releaseFirst();
  await bundle.session.waitForIdle();

  const queuedUsers = bundle.session.sessionManager.getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "user" && entry.message.piWeb?.inlineSkillContext)
    .map((entry) => entry.message);
  assert.equal(queuedUsers.length, 2);
  assert.deepEqual(queuedUsers.map(textContent), [raw, raw]);
  const snapshots = queuedUsers.map((message) => message.piWeb.inlineSkillContext);
  assert.notEqual(snapshots[0].requestId, snapshots[1].requestId);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.skills[0].body), ["QUEUED_SNAPSHOT_V1", "QUEUED_SNAPSHOT_V2"]);
  assert.match(JSON.stringify(providerContexts[1].messages), /QUEUED_SNAPSHOT_V1/);
  assert.doesNotMatch(JSON.stringify(providerContexts[1].messages), /QUEUED_SNAPSHOT_V2/);
  assert.match(JSON.stringify(providerContexts[2].messages), /QUEUED_SNAPSHOT_V2/);
  for (const context of providerContexts) {
    assert.ok(context.messages.every((message) => !Object.hasOwn(message, "piWeb")));
  }
});

test("clearing the SDK queue discards its snapshot without leaking it into a later turn", async (t) => {
  const f = await fixture(t);
  await f.writeSkill("alpha", "CLEARED_SNAPSHOT_MUST_NOT_LEAK");
  const bundle = await createWrappedSession(f);
  t.after(() => closeBundle(bundle));
  const providerContexts = [];
  let startFirst;
  const firstStarted = new Promise((resolve) => { startFirst = resolve; });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  bundle.faux.setResponses([
    async (context) => {
      providerContexts.push(structuredClone(context));
      startFirst();
      await firstGate;
      return fauxAssistantMessage([fauxText("gate complete")]);
    },
    (context) => {
      providerContexts.push(structuredClone(context));
      return fauxAssistantMessage([fauxText("next turn complete")]);
    },
  ]);

  await bundle.wrapper.send({ type: "prompt", message: "Start the gated run." });
  await firstStarted;
  await bundle.wrapper.send({ type: "steer", message: "Use $alpha, then clear this queued request." });
  await bundle.wrapper.send({ type: "clear_queue" });
  releaseFirst();
  await bundle.session.waitForIdle();
  await sendPrompt(bundle, "A fresh request after queue clear.");

  assert.equal(providerContexts.length, 2);
  assert.doesNotMatch(JSON.stringify(providerContexts[1].messages), /CLEARED_SNAPSHOT_MUST_NOT_LEAK/);
  assert.ok(bundle.session.sessionManager.getBranch().every((entry) => (
    entry.type !== "message" || !entry.message.piWeb?.inlineSkillContext
  )));
});

test("handled Web input and nested extension send do not leave an orphan snapshot", async (t) => {
  const f = await fixture(t);
  await f.writeSkill("alpha", "ORPHAN_SNAPSHOT_MUST_NOT_LEAK");
  const nestedInputExtension = {
    name: "inline-skill-nested-input-test",
    factory(pi) {
      pi.on("input", (event) => {
        if (event.source !== "rpc" || event.text !== "handle-and-send $alpha") return;
        pi.sendUserMessage("Extension-owned separate request");
        return { action: "handled" };
      });
    },
  };
  const bundle = await createWrappedSession(f, { extensionFactories: [nestedInputExtension] });
  t.after(() => closeBundle(bundle));
  const providerContexts = [];
  bundle.faux.setResponses([
    (context) => {
      providerContexts.push(structuredClone(context));
      return fauxAssistantMessage([fauxText("nested send complete")]);
    },
    (context) => {
      providerContexts.push(structuredClone(context));
      return fauxAssistantMessage([fauxText("next turn complete")]);
    },
  ]);

  await bundle.wrapper.send({ type: "prompt", message: "handle-and-send $alpha" });
  await bundle.session.waitForIdle();
  const userEntries = bundle.session.sessionManager.getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "user");
  assert.ok(userEntries.some((entry) => textContent(entry.message) === "Extension-owned separate request"));
  assert.ok(userEntries.every((entry) => !entry.message.piWeb?.inlineSkillContext));
  await sendPrompt(bundle, "Next ordinary turn.");
  assert.doesNotMatch(JSON.stringify(providerContexts[0].messages), /ORPHAN_SNAPSHOT_MUST_NOT_LEAK/);
  assert.doesNotMatch(JSON.stringify(providerContexts[1].messages), /ORPHAN_SNAPSHOT_MUST_NOT_LEAK/);
});

test("direct queued steer/follow-up handlers cannot transfer Web reservations to extension sends", async (t) => {
  const f = await fixture(t);
  await f.writeSkill("alpha", "DIRECT_QUEUE_ORPHAN_MUST_NOT_LEAK");
  const seenInputSources = [];
  const nestedInputs = [
    ["handle-direct-steer $alpha", "Extension-owned nested steer", "steer"],
    ["handle-direct-follow-up $alpha", "Extension-owned nested follow-up", "followUp"],
    ["handle-streaming-prompt $alpha", "Extension-owned queued-prompt steer", "steer"],
  ];
  const inputHandlerExtension = {
    name: "inline-skill-direct-queue-handler-test",
    factory(pi) {
      pi.on("input", (event) => {
        if (event.source === "extension") return;
        const match = nestedInputs.find(([text]) => text === event.text);
        if (!match) return;
        seenInputSources.push(event.source);
        pi.sendUserMessage(match[1], { deliverAs: match[2] });
        return { action: "handled" };
      });
    },
  };
  const bundle = await createWrappedSession(f, { extensionFactories: [inputHandlerExtension] });
  t.after(() => closeBundle(bundle));
  const providerContexts = [];
  let startFirst;
  const firstStarted = new Promise((resolve) => { startFirst = resolve; });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const respond = (context) => {
    providerContexts.push(structuredClone(context));
    return fauxAssistantMessage([fauxText("queued response")]);
  };
  bundle.faux.setResponses([
    async (context) => {
      providerContexts.push(structuredClone(context));
      startFirst();
      await firstGate;
      return fauxAssistantMessage([fauxText("gate complete")]);
    },
    respond, respond, respond, respond,
  ]);

  await bundle.wrapper.send({ type: "prompt", message: "Start the gated run." });
  await firstStarted;
  await bundle.wrapper.send({ type: "steer", message: "handle-direct-steer $alpha" });
  await waitForQueuedMessage(() => bundle.session.getSteeringMessages(), "Extension-owned nested steer");
  await bundle.wrapper.send({ type: "follow_up", message: "handle-direct-follow-up $alpha" });
  await waitForQueuedMessage(() => bundle.session.getFollowUpMessages(), "Extension-owned nested follow-up");
  await bundle.wrapper.send({
    type: "prompt",
    message: "handle-streaming-prompt $alpha",
    streamingBehavior: "steer",
  });
  await waitForQueuedMessage(() => bundle.session.getSteeringMessages(), "Extension-owned queued-prompt steer");
  releaseFirst();
  await bundle.session.waitForIdle();

  assert.deepEqual(seenInputSources, ["interactive", "interactive", "rpc"]);
  const nestedEntries = bundle.session.sessionManager.getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "user")
    .filter((entry) => nestedInputs.some(([, text]) => textContent(entry.message) === text));
  assert.equal(nestedEntries.length, 3);
  assert.ok(nestedEntries.every((entry) => !entry.message.piWeb?.inlineSkillContext));
  assert.ok(providerContexts.every((context) => !JSON.stringify(context.messages).includes("DIRECT_QUEUE_ORPHAN_MUST_NOT_LEAK")));
});

test("durable snapshot stays separate from raw text and reprojects after reopening with changed skill files", async (t) => {
  const f = await fixture(t);
  const skillPath = await f.writeSkill("alpha", "DURABLE_SNAPSHOT_V1");
  const sessionManager = SessionManager.create(f.cwd, f.sessionDir);
  const first = await createWrappedSession(f, { sessionManager });
  t.after(() => closeBundle(first));
  let initialProviderContext;
  first.faux.setResponses([(context) => {
    initialProviderContext = structuredClone(context);
    return fauxAssistantMessage([fauxText("initial response")]);
  }]);
  const raw = "Use $alpha in this request.";
  await sendPrompt(first, raw);
  const userEntry = first.session.sessionManager.getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  assert.equal(textContent(userEntry.message), raw);
  assert.equal(userEntry.message.piWeb.inlineSkillContext.skills[0].body, "DURABLE_SNAPSHOT_V1");
  assert.match(JSON.stringify(initialProviderContext.messages), /DURABLE_SNAPSHOT_V1/);
  assert.ok(initialProviderContext.messages.every((message) => !Object.hasOwn(message, "piWeb")));
  const sessionFile = first.session.sessionFile;
  assert.ok(sessionFile);
  const forkFile = first.session.sessionManager.createBranchedSession(userEntry.id);
  assert.ok(forkFile, "the persisted SDK branch was created");
  await closeBundle(first);

  await writeFile(skillPath, "---\nname: alpha\ndescription: alpha test skill\n---\nDURABLE_SNAPSHOT_V2\n");
  const forked = await createWrappedSession(f, {
    sessionManager: SessionManager.open(forkFile, f.sessionDir),
  });
  t.after(() => closeBundle(forked));
  let forkProviderContext;
  forked.faux.setResponses([(context) => {
    forkProviderContext = structuredClone(context);
    return fauxAssistantMessage([fauxText("forked response")]);
  }]);
  await sendPrompt(forked, "Continue from the persisted fork.");
  assert.match(JSON.stringify(forkProviderContext.messages), /DURABLE_SNAPSHOT_V1/);
  assert.doesNotMatch(JSON.stringify(forkProviderContext.messages), /DURABLE_SNAPSHOT_V2/);

  const resumed = await createWrappedSession(f, {
    sessionManager: SessionManager.open(sessionFile, f.sessionDir),
  });
  t.after(() => closeBundle(resumed));
  let resumedProviderContext;
  resumed.faux.setResponses([(context) => {
    resumedProviderContext = structuredClone(context);
    return fauxAssistantMessage([fauxText("resumed response")]);
  }]);
  await sendPrompt(resumed, "Continue from the saved request.");
  assert.match(JSON.stringify(resumedProviderContext.messages), /DURABLE_SNAPSHOT_V1/);
  assert.doesNotMatch(JSON.stringify(resumedProviderContext.messages), /DURABLE_SNAPSHOT_V2/);
  assert.equal(textContent(userEntry.message), raw, "the historical persisted user body remains raw");
});

test("session_before_compact adds saved hidden skill bodies to actual Faux summary input", async (t) => {
  const f = await fixture(t);
  const skillPath = await f.writeSkill("alpha", "COMPACTION_SNAPSHOT_BODY");
  const settingsManagerConfig = {
    images: { autoResize: false },
    compaction: { reserveTokens: 256, keepRecentTokens: 1 },
  };
  const sessionManager = SessionManager.inMemory(f.cwd);
  const bundle = await createWrappedSession(f, {
    sessionManager,
    settings: settingsManagerConfig,
  });
  t.after(() => closeBundle(bundle));
  const oldRequest = "Older raw request with $alpha.";
  const metadata = storedSkillContext(
    "compact-request-1",
    skillPath,
    join(f.cwd, ".agents", "skills", "alpha"),
    "COMPACTION_SNAPSHOT_BODY",
  );
  appendUser(sessionManager, oldRequest, metadata);
  sessionManager.appendMessage(fauxAssistantMessage([fauxText("older assistant response") ]));
  appendUser(sessionManager, "A later raw request.");
  sessionManager.appendMessage(fauxAssistantMessage([fauxText("later assistant response") ]));

  const summaryInputs = [];
  const summarize = (context) => {
    summaryInputs.push(structuredClone(context));
    return fauxAssistantMessage([fauxText("compaction summary")]);
  };
  bundle.faux.setResponses([summarize, summarize, summarize]);
  await bundle.session.compact();
  assert.ok(summaryInputs.length > 0, "the SDK called its actual summarization provider");
  assert.ok(summaryInputs.some((context) => JSON.stringify(context.messages).includes("COMPACTION_SNAPSHOT_BODY")));
  assert.ok(summaryInputs.every((context) => context.messages.every((message) => !Object.hasOwn(message, "piWeb"))));
  assert.ok(summaryInputs.every((context) => !JSON.stringify(context.messages).includes("compact-request-1")));
  const compactionEntry = sessionManager.getBranch().find((entry) => entry.type === "compaction");
  assert.ok(compactionEntry);
  let postCompactionContext;
  bundle.faux.setResponses([(context) => {
    postCompactionContext = structuredClone(context);
    return fauxAssistantMessage([fauxText("post-compaction response")]);
  }]);
  await sendPrompt(bundle, "A fresh turn after compaction.");
  assert.doesNotMatch(JSON.stringify(postCompactionContext.messages), /COMPACTION_SNAPSHOT_BODY/);
});

test("session_before_tree adds saved hidden skill bodies to actual branch-summary input", async (t) => {
  const f = await fixture(t);
  const skillPath = await f.writeSkill("alpha", "BRANCH_SNAPSHOT_BODY");
  const sessionManager = SessionManager.inMemory(f.cwd);
  const bundle = await createWrappedSession(f, { sessionManager });
  t.after(() => closeBundle(bundle));
  appendUser(sessionManager, "Common history.");
  sessionManager.appendMessage(fauxAssistantMessage([fauxText("common answer") ]));
  const commonLeafId = sessionManager.getLeafId();
  const oldRequest = "Abandoned raw request with $alpha.";
  appendUser(sessionManager, oldRequest, storedSkillContext(
    "branch-request-1",
    skillPath,
    join(f.cwd, ".agents", "skills", "alpha"),
    "BRANCH_SNAPSHOT_BODY",
  ));
  const oldLeafId = sessionManager.appendMessage(fauxAssistantMessage([fauxText("abandoned assistant response") ]));
  sessionManager.branch(commonLeafId);
  appendUser(sessionManager, "Target branch request.");
  const targetLeafId = sessionManager.appendMessage(fauxAssistantMessage([fauxText("target assistant response") ]));
  sessionManager.branch(oldLeafId);

  let summaryInput;
  bundle.faux.setResponses([(context) => {
    summaryInput = structuredClone(context);
    return fauxAssistantMessage([fauxText("branch summary")]);
  }]);
  await bundle.session.navigateTree(targetLeafId, { summarize: true });
  assert.ok(summaryInput, "the SDK called its actual branch-summary provider");
  assert.match(JSON.stringify(summaryInput.messages), /BRANCH_SNAPSHOT_BODY/);
  assert.ok(JSON.stringify(summaryInput.messages).includes("Abandoned raw request with $alpha."));
  assert.ok(summaryInput.messages.every((message) => !Object.hasOwn(message, "piWeb")));
  assert.doesNotMatch(JSON.stringify(summaryInput.messages), /branch-request-1/);
  assert.ok(sessionManager.getBranch().some((entry) => entry.type === "branch_summary"));
  let postNavigationContext;
  bundle.faux.setResponses([(context) => {
    postNavigationContext = structuredClone(context);
    return fauxAssistantMessage([fauxText("post-navigation response")]);
  }]);
  await sendPrompt(bundle, "A fresh turn on the target branch.");
  assert.doesNotMatch(JSON.stringify(postNavigationContext.messages), /BRANCH_SNAPSHOT_BODY/);
});

test("Agent public method wrappers are active after reload and restored on disposal", async (t) => {
  const f = await fixture(t);
  await f.writeSkill("alpha", "WRAPPER_RELOAD_BODY");
  const bundle = await createWrappedSession(f);
  t.after(() => closeBundle(bundle));
  assert.notEqual(bundle.session.agent.prompt, bundle.originalAgentMethods.prompt);
  await bundle.wrapper.send({ type: "reload" });
  let providerContext;
  bundle.faux.setResponses([(context) => {
    providerContext = structuredClone(context);
    return fauxAssistantMessage([fauxText("after reload")]);
  }]);
  await sendPrompt(bundle, "Use $alpha after reload.");
  assert.match(JSON.stringify(providerContext.messages), /WRAPPER_RELOAD_BODY/);
  await closeBundle(bundle);
  assert.equal(bundle.session.agent.prompt, bundle.originalAgentMethods.prompt);
  assert.equal(bundle.session.agent.steer, bundle.originalAgentMethods.steer);
  assert.equal(bundle.session.agent.followUp, bundle.originalAgentMethods.followUp);
});

test("registered extension commands keep original arguments and native /skill:name still works", async (t) => {
  const f = await fixture(t);
  await f.writeSkill("alpha", "SLASH_ALPHA_BODY", { disabled: true });
  let capturedArgs;
  const commandExtension = {
    name: "inline-command-test",
    factory: (pi) => pi.registerCommand("capture-inline", {
      description: "Capture original slash arguments",
      handler: async (args) => { capturedArgs = args; },
    }),
  };
  const bundle = await createWrappedSession(f, { extensionFactories: [commandExtension] });
  t.after(() => closeBundle(bundle));

  await bundle.wrapper.send({ type: "prompt", message: "/capture-inline preserve $alpha exactly" });
  assert.equal(capturedArgs, "preserve $alpha exactly");
  assert.equal(bundle.faux.state.callCount, 0, "the extension command is not submitted to the provider");

  let captured;
  bundle.faux.setResponses([(context) => {
    captured = structuredClone(context);
    return fauxAssistantMessage([fauxText("skill command done")]);
  }]);
  await sendPrompt(bundle, "/skill:alpha", undefined);
  assert.match(userMessages(captured).map(textContent).join("\n"), /SLASH_ALPHA_BODY/);
});

test("project trust gates resources on open, reload, and resumed sessions", async (t) => {
  const f = await fixture(t);
  const skillPath = await f.writeSkill("alpha", "ALPHA_BODY_V1");
  const sessionManager = SessionManager.create(f.cwd, f.sessionDir);
  const bundle = await createWrappedSession(f, { trusted: false, sessionManager });
  t.after(() => closeBundle(bundle));

  assert.deepEqual(bundle.services.resourceLoader.getSkills().skills.map((skill) => skill.name), []);
  let firstContext;
  bundle.faux.setResponses([(context) => {
    firstContext = structuredClone(context);
    return fauxAssistantMessage([fauxText("untrusted done")]);
  }]);
  await sendPrompt(bundle, "Try $alpha while the project is untrusted.");
  assert.match(textContent(userMessages(firstContext).at(-1)), /\$alpha/);
  assert.doesNotMatch(textContent(userMessages(firstContext).at(-1)), /ALPHA_BODY_V1/);

  // Trust is read by the production reload callback, and wrapper.reload is the
  // same serialized Web command used before subsequent sends.
  new ProjectTrustStore(f.agentDir).set(f.cwd, true);
  await bundle.wrapper.send({ type: "reload" });
  assert.deepEqual(bundle.services.resourceLoader.getSkills().skills.map((skill) => skill.name), ["alpha"]);
  await writeFile(skillPath, "---\nname: alpha\ndescription: alpha test skill\n---\nALPHA_BODY_V2\n");
  await bundle.wrapper.send({ type: "reload" });
  let reloadedContext;
  bundle.faux.setResponses([(context) => {
    reloadedContext = structuredClone(context);
    return fauxAssistantMessage([fauxText("reloaded done")]);
  }]);
  await sendPrompt(bundle, "Reloaded reference $alpha.");
  assert.match(textContent(userMessages(reloadedContext).at(-1)), /ALPHA_BODY_V2/);

  const sessionFile = bundle.session.sessionFile;
  assert.ok(sessionFile);
  await closeBundle(bundle);
  const resumed = await createWrappedSession(f, {
    trusted: true,
    sessionManager: SessionManager.open(sessionFile, f.sessionDir),
  });
  t.after(() => closeBundle(resumed));
  let resumedContext;
  resumed.faux.setResponses([(context) => {
    resumedContext = structuredClone(context);
    return fauxAssistantMessage([fauxText("resumed done")]);
  }]);
  await sendPrompt(resumed, "Resumed reference $alpha.");
  assert.match(textContent(userMessages(resumedContext).at(-1)), /ALPHA_BODY_V2/);

  // Revoking trust before another resume excludes the project skill despite the
  // historical transcript and persisted resource path.
  const resumedFile = resumed.session.sessionFile;
  await closeBundle(resumed);
  new ProjectTrustStore(f.agentDir).set(f.cwd, false);
  const untrustedResume = await createWrappedSession(f, {
    trusted: false,
    sessionManager: SessionManager.open(resumedFile, f.sessionDir),
  });
  t.after(() => closeBundle(untrustedResume));
  assert.deepEqual(untrustedResume.services.resourceLoader.getSkills().skills.map((skill) => skill.name), []);
  let untrustedContext;
  untrustedResume.faux.setResponses([(context) => {
    untrustedContext = structuredClone(context);
    return fauxAssistantMessage([fauxText("still untrusted")]);
  }]);
  await sendPrompt(untrustedResume, "Untrusted resumed reference $alpha.");
  assert.match(textContent(userMessages(untrustedContext).at(-1)), /\$alpha/);
  assert.doesNotMatch(textContent(userMessages(untrustedContext).at(-1)), /ALPHA_BODY_V2/);
});

test("a loaded skill disappearing before send fails before SDK/provider submission", async (t) => {
  const f = await fixture(t);
  const skillPath = await f.writeSkill("alpha", "ALPHA_BODY");
  const bundle = await createWrappedSession(f);
  t.after(() => closeBundle(bundle));
  assert.equal(bundle.services.resourceLoader.getSkills().skills.length, 1);
  await rm(skillPath);

  await assert.rejects(
    bundle.wrapper.send({ type: "prompt", message: "Use $alpha." }),
    /Inline skill \"\$alpha\" could not be read/,
  );
  assert.equal(bundle.faux.state.callCount, 0);
  assert.equal(bundle.session.pendingMessageCount, 0);
});

test("recognized skill requests reject visibly when the public Agent boundary is unavailable", async (t) => {
  const f = await fixture(t);
  await f.writeSkill("alpha", "UNATTACHABLE_SNAPSHOT");
  const bundle = await createWrappedSession(f, { unavailableAgentMethod: "steer" });
  t.after(async () => {
    bundle.session.agent.steer = bundle.originalAgentMethods.steer;
    await closeBundle(bundle);
  });
  let providerContext;
  bundle.faux.setResponses([(context) => {
    providerContext = structuredClone(context);
    return fauxAssistantMessage([fauxText("plain request accepted")]);
  }]);

  await assert.rejects(
    bundle.wrapper.send({ type: "prompt", message: "Use $alpha." }),
    /public SDK user-message boundary is unavailable/,
  );
  assert.equal(bundle.faux.state.callCount, 0);
  await sendPrompt(bundle, "A plain request without a loaded-skill reference.");
  assert.ok(providerContext);
  assert.doesNotMatch(JSON.stringify(providerContext.messages), /UNATTACHABLE_SNAPSHOT/);
});

test("the wrapper's generic default leaves expansion disabled for non-Web callers", async (t) => {
  const f = await fixture(t);
  await f.writeSkill("alpha", "SUBAGENT_MUST_NOT_INLINE");
  const bundle = await createWrappedSession(f, { enableInlineSkillExpansion: false });
  t.after(() => closeBundle(bundle));
  let context;
  bundle.faux.setResponses([(seen) => {
    context = structuredClone(seen);
    return fauxAssistantMessage([fauxText("no inline expansion")]);
  }]);
  await sendPrompt(bundle, "Keep $alpha unchanged.");
  const latestUserText = textContent(userMessages(context).at(-1));
  assert.match(latestUserText, /\$alpha/);
  assert.doesNotMatch(latestUserText, /SUBAGENT_MUST_NOT_INLINE/);
});
