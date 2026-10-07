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
  const settingsManager = SettingsManager.inMemory({ images: { autoResize: false } });
  const trustReloadOptions = projectTrustReloadOptions(f.cwd, f.agentDir);
  const services = await createAgentSessionServices({
    cwd: f.cwd,
    agentDir: f.agentDir,
    modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      extensionFactories,
      noExtensions: extensionFactories.length === 0,
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
  const wrapper = new AgentSessionWrapper(session, { enableInlineSkillExpansion });
  wrapper.start();
  wrapper.beginExtensionBinding();
  return { faux, modelRuntime, services, session, wrapper };
}

function textContent(message) {
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function userMessages(context) {
  return context.messages.filter((message) => message.role === "user");
}

async function sendPrompt(bundle, message, images) {
  await bundle.wrapper.send({ type: "prompt", message, ...(images ? { images } : {}) });
  await bundle.session.waitForIdle();
}

async function closeBundle(bundle) {
  await bundle.wrapper.shutdown();
}

test("prompt, steering, and follow-up sends expand only the loaded catalog and retain images", async (t) => {
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
  assert.match(firstText, /ALPHA_BODY/);
  assert.match(firstText, /\$unknown/);
  assert.equal(firstUser.content.filter((block) => block.type === "image").length, 1);
  assert.equal(firstUser.content.find((block) => block.type === "image").data, ONE_PIXEL_PNG);

  const steerUserMessages = userMessages(contexts[1]);
  const steerText = steerUserMessages.map(textContent).join("\n");
  assert.match(steerText, /Steer with \$beta\./);
  assert.match(steerText, /BETA_BODY/);
  assert.equal(steerUserMessages.at(-1).content.find((block) => block.type === "image").data, ONE_PIXEL_PNG);
  const followUserMessages = userMessages(contexts[2]);
  const followText = followUserMessages.map(textContent).join("\n");
  assert.match(followText, /Follow up with \$gamma\./);
  assert.match(followText, /GAMMA_BODY/);
  assert.equal(followUserMessages.at(-1).content.find((block) => block.type === "image").data, ONE_PIXEL_PNG);
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
