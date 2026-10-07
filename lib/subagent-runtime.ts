import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import {
  subagentNotificationText,
  subagentToolDetails,
  type ResumeSubagentRequest,
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  readSubagentRun,
  resolveSubagentProfile,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  selectSubagentExtensionTools,
  withSubagentExtensionTools,
  type SubagentMetadata,
  type SubagentResultMetadata,
  type SubagentRunInfo,
  type SubagentTelemetry,
} from "./subagents";
import type { SessionEntry } from "./types";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { createExactSystemPromptExtension } from "./exact-system-prompt";
import { appendSubagentInputFiles, loadSubagentInputFiles } from "./subagent-input";
import { projectTrustReloadOptions } from "./project-trust";
import { resolveShellTools } from "./powershell-settings";
import { isBuiltInSubagentsEnabled, readSubagentSettings } from "./subagent-settings";
import { SubagentQueue } from "./subagent-queue";
import { addWorktree, removeWorktree } from "./worktree";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { validateResourceSelection } from "./subagent-resource-selection";
import { subagentResourceLoaderOptions, subagentSessionToolOptions } from "./subagent-resources";
import { resolveSubagentExecutionModel, validateSubagentExecutionChoices } from "./subagent-policy";

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  waitUntilReady(): Promise<void>;
}

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: { exactSystemPrompt?: string; chatOnly?: boolean },
  ): void;
  reopenSession(sessionId: string, sessionFile: string): Promise<HostSession>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
  cancelQueued?: () => boolean;
};

declare global {
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentQueue: SubagentQueue<SubagentRunInfo> | undefined;
  var __piSubagentConsumedResults: Map<string, string> | undefined;
  var __piSubagentNotifications: number | undefined;
}
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const PARENT_IDLE_POLL_MS = 200;

/** pi's agent loop records provider failures as an assistant message with `stopReason: "error"` and resolves `prompt()` normally; surface that as a failed run. */
function lastAssistantError(sessionManager: { getEntries?: () => unknown }): string | undefined {
  const entries = sessionManager.getEntries?.();
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason !== "error") return undefined;
    return typeof entry.message.errorMessage === "string" && entry.message.errorMessage ? entry.message.errorMessage : "Provider returned an error";
  }
  return undefined;
}

/** The SDK defers setup-only files until a conversation; queued aborts still need durable results. */
function appendSubagentResult(manager: SessionManager, result: SubagentResultMetadata): void {
  manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, result);
  const path = manager.getSessionFile?.();
  if (!path || existsSync(path)) return;
  const header = manager.getHeader();
  if (!header) return;
  writeFileSync(path, [header, ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  // Reload this same file so later SDK appends don't attempt the deferred first write.
  manager.setSessionFile(path);
}

function getSubagentRuns(): Map<string, StoredSubagentExecution> {
  if (!globalThis.__piSubagentRuns) globalThis.__piSubagentRuns = new Map();
  return globalThis.__piSubagentRuns;
}

export function hasBusySubagentWork(): boolean {
  return (globalThis.__piSubagentNotifications ?? 0) > 0
    || [...(globalThis.__piSubagentRuns?.values() ?? [])].some(({ run }) => run.status === "queued" || run.status === "running");
}

function getSubagentQueue(): SubagentQueue<SubagentRunInfo> {
  if (!globalThis.__piSubagentQueue) globalThis.__piSubagentQueue = new SubagentQueue();
  return globalThis.__piSubagentQueue;
}

type SubagentRunIdentity = Pick<SubagentRunInfo, "sessionId" | "completedAt">;

/**
 * Background runs whose terminal result the parent already collected with `get_subagent_result`,
 * keyed by subagent session ID and holding the collected run's `completedAt`. `resume` reruns
 * the same session ID, so the mark must name the run: a parent that polls *after* a run's
 * notification was delivered leaves a mark nothing consumes, and a bare session ID would let it
 * swallow the next run's notification (#987). `resume` deliberately does not clear the entry:
 * the parent can collect a run and resume it in the same turn while that run's notification is
 * still held, and the mark must keep suppressing it. Only background runs are recorded — a
 * foreground run never notifies — and each session holds at most one entry.
 */
function getConsumedSubagentResults(): Map<string, string> {
  // A hot reload can leave the pre-#987 Set on globalThis; replace it rather than call Map methods on it.
  if (!(globalThis.__piSubagentConsumedResults instanceof Map)) globalThis.__piSubagentConsumedResults = new Map();
  return globalThis.__piSubagentConsumedResults;
}

function markResultConsumed(run: SubagentRunIdentity): void {
  // A terminal run without `completedAt` (interrupted) never notifies, so there is nothing to drop.
  if (!run.completedAt) return;
  getConsumedSubagentResults().set(run.sessionId, run.completedAt);
}

/** Take the mark only when it names this very run; a mark left by an earlier run is ignored. */
function takeResultConsumed(run: SubagentRunIdentity): boolean {
  const consumed = getConsumedSubagentResults();
  if (!run.completedAt || consumed.get(run.sessionId) !== run.completedAt) return false;
  consumed.delete(run.sessionId);
  return true;
}

/**
 * A run lives in `getSubagentRuns()` from dispatch until its result entry is written, so a
 * persisted `running` / `queued` status reaching `get()` without that entry (and without a running
 * wrapper) was left by a process that stopped mid-run and will never be finished. Report it as
 * `interrupted` so `get_subagent_result({ wait: true })` returns instead of polling forever, and
 * `resume` can pick the session up again.
 */
function settleOrphanedRun(run: SubagentRunInfo): SubagentRunInfo {
  return run.status === "running" || run.status === "queued" ? { ...run, status: "interrupted" } : run;
}

function parentContextText(parent: HostSession): string {
  const messages = parent.inner.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  if (serialized.length <= SUBAGENT_CONTEXT_LIMIT) return serialized;
  return `${serialized.slice(0, SUBAGENT_CONTEXT_LIMIT)}\n[Parent context truncated]`;
}

async function cleanupWorktree(
  parentCwd: string,
  worktree: { path: string; branch: string } | undefined,
): Promise<string | undefined> {
  if (!worktree) return undefined;
  try {
    await removeWorktree(parentCwd, worktree.path);
    return undefined;
  } catch (error) {
    return `Worktree retained at ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function createSubagentController(
  dependencies: SubagentRuntimeDependencies,
): SubagentController {
  async function start(request: StartSubagentRequest): Promise<SubagentExecution> {
    const choices = validateSubagentExecutionChoices(request);
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    if (!parent.sessionFile) throw new Error("Parent session must be persisted before starting a subagent");

    let isolatedWorktree: { path: string; branch: string } | undefined;
    try {
      const profile = resolveSubagentProfile(parent.cwd, request.profile);
      if (!profile) throw new Error(`Unknown or disabled subagent profile: ${request.profile}`);

      const { runInBackground, isolation, inheritContext, thinking, maxTurns: turnLimit } = choices;
      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;
      const requestedModel = resolveSubagentExecutionModel(parentModelRuntime, choices);
      if (isolation === "worktree") {
        isolatedWorktree = await addWorktree(parent.cwd, `pi-web-agent-${randomUUID()}`);
      }
      const childCwd = isolatedWorktree?.path ?? parent.cwd;
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(childCwd, agentDir);
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const inputFiles = loadSubagentInputFiles(parent.cwd, request.inputFiles ?? []);
      const sessionManager = isolatedWorktree
        ? SessionManager.create(childCwd, undefined, { parentSession: parent.sessionFile })
        : SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile });
      // In-process children share environment variables with the parent. Bind native
      // caller identity once in the frozen prompt, never infer it from PI_SESSION_ID.
      const callerContextPrompt = profile.mcpServers?.length
        ? `\n\nNative Pi Web child caller_context: ${JSON.stringify({ cwd: childCwd, harness: "pi", session_id: sessionManager.getSessionId(), actor: "pi" })}. Use this identity for shared-memory; environment PI_SESSION_ID may name the parent. No project/task ID is asserted here.`
        : "";
      const promptPlan = buildSubagentPromptPlan({
        profileSystemPrompt: profile.systemPrompt + callerContextPrompt,
        tools: profile.tools,
        loadSkills: profile.loadSkills,
        loadExtensions: profile.loadExtensions || Boolean(profile.mcpServers?.length),
        promptMode: profile.promptMode,
        task: appendSubagentInputFiles(request.task, inputFiles),
        inheritedParentContext,
      });
      const { chatOnly, appendSystemPrompt, delegatedTask } = promptPlan;
      if (!chatOnly) initTheme();
      const selectedResourceOptions = await subagentResourceLoaderOptions(profile, childCwd, agentDir);
      const services = await createAgentSessionServices({
        cwd: childCwd,
        agentDir,
        modelRuntime: parentModelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          ...selectedResourceOptions,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(chatOnly || promptPlan.exactSystemPrompt !== undefined
            ? {
                systemPrompt: " ",
                systemPromptOverride: () => undefined,
              }
            : {}),
          appendSystemPrompt,
          // The exact prompt is sent through before_agent_start; see lib/exact-system-prompt.ts.
          extensionFactories: [
            ...(selectedResourceOptions.extensionFactories ?? []),
            ...(promptPlan.exactSystemPrompt !== undefined ? [createExactSystemPromptExtension(() => promptPlan.exactSystemPrompt)] : []),
          ],
        },
        ...((profile.loadExtensions || profile.loadSkills || profile.mcpServers?.length)
          ? { resourceLoaderReloadOptions: projectTrustReloadOptions(childCwd, agentDir) }
          : {}),
      });

      const extensionToolNames = profile.loadExtensions
        ? profile.extensionTools?.length
          ? selectSubagentExtensionTools(
            services.resourceLoader.getExtensions().extensions,
            profile.extensionTools,
            profile.disallowedExtensionTools,
          )
          : services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
        : [];
      const activeTools = resolveShellTools(
        withSubagentExtensionTools(profile.tools, extensionToolNames),
        settingsManager.getDefaultTools(),
      );

      const createdAt = new Date().toISOString();
      const metadata: SubagentMetadata = {
        version: 1,
        parentSessionId,
        parentSessionPath: parent.sessionFile,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: request.description.trim() || profile.displayName,
        task: request.task,
        runInBackground,
        createdAt,
        resourceSnapshot: {
          version: 1,
          appendSystemPrompt: [...appendSystemPrompt],
          tools: [...activeTools],
          loadSkills: profile.loadSkills,
          loadExtensions: profile.loadExtensions,
          ...validateResourceSelection(profile),
          ...(promptPlan.exactSystemPrompt !== undefined ? { exactSystemPrompt: promptPlan.exactSystemPrompt } : {}),
        },
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };
      sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
      sessionManager.appendSessionInfo(metadata.description);

      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: requestedModel,
        thinkingLevel: thinking,
        ...subagentSessionToolOptions({ ...profile, tools: activeTools }, services.resourceLoader.getExtensions()),
      });
      dependencies.registerSession(inner, {
        ...(promptPlan.exactSystemPrompt !== undefined
          ? { exactSystemPrompt: promptPlan.exactSystemPrompt }
          : {}),
        chatOnly,
      });

      const initialRun: SubagentRunInfo = {
        sessionId: inner.sessionId,
        sessionPath: inner.sessionFile ?? sessionManager.getSessionFile() ?? "",
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: metadata.description,
        task: request.task,
        runInBackground,
        status: "queued",
        createdAt,
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };

      let turnCount = 0;
      let maxTurnsReached = false;
      let softLimitReached = false;
      const telemetry = (terminationReason: SubagentTelemetry["terminationReason"]): SubagentTelemetry => ({ turnCount, turnCountBasis: "turn_end", terminationReason });
      const unsubscribeTurns = inner.subscribe((event) => {
        if (event.type !== "turn_end" || stored.run.status !== "running") return;
        turnCount += 1;
        if (turnLimit && !softLimitReached && turnCount >= turnLimit) {
          softLimitReached = true;
          void inner.steer("You have reached your turn limit. Wrap up immediately and provide your final answer now.");
        } else if (turnLimit && softLimitReached && turnCount >= turnLimit + 1) {
          maxTurnsReached = true;
          void inner.abort();
        }
      });
      let resolveCompletion!: (run: SubagentRunInfo) => void;
      const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion,
        abortRequested: false,
      };
      getSubagentRuns().set(initialRun.sessionId, stored);
      request.onUpdate?.(initialRun);
      dependencies.invalidateSessionList();

      const handleParentAbort = () => {
        stored.abortRequested = true;
        if (stored.run.status === "queued") stored.cancelQueued?.();
        else void inner.abort();
      };
      if (!runInBackground) {
        request.signal?.addEventListener("abort", handleParentAbort, { once: true });
        if (request.signal?.aborted) handleParentAbort();
      }
      const unsubscribeInvocation = () => {
        unsubscribeTurns();
        request.signal?.removeEventListener("abort", handleParentAbort);
      };

      const execute = async (): Promise<SubagentRunInfo> => {
        if (stored.abortRequested) {
          unsubscribeInvocation();
          const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString(), telemetry: telemetry("abort-requested") };
          appendSubagentResult(sessionManager, { version: 1, status: "aborted", completedAt: result.completedAt!, telemetry: result.telemetry });
          await cleanupWorktree(parent.cwd, isolatedWorktree);
          stored.run = result;
          request.onUpdate?.(result);
          getSubagentRuns().delete(initialRun.sessionId);
          dependencies.invalidateSessionList();
          return result;
        }
        stored.run = { ...stored.run, status: "running" };
        sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
        request.onUpdate?.(stored.run);
        dependencies.invalidateSessionList();
        let result: SubagentRunInfo;
        try {
          await inner.prompt(delegatedTask, { source: "rpc" });
          const text = inner.getLastAssistantText()?.trim();
          const aborted = stored.abortRequested && !maxTurnsReached;
          const providerError = aborted ? undefined : lastAssistantError(sessionManager);
          result = {
            ...initialRun,
            status: aborted ? "aborted" : providerError ? "failed" : "completed",
            completedAt: new Date().toISOString(),
            telemetry: telemetry(maxTurnsReached ? "max-turns" : aborted ? "abort-requested" : providerError ? "provider-error" : "completed"),
            ...(text ? { result: text } : {}),
            ...(providerError ? { error: providerError } : {}),
          };
        } catch (error) {
          const text = inner.getLastAssistantText()?.trim();
          const aborted = stored.abortRequested || request.signal?.aborted;
          result = {
            ...initialRun,
            status: aborted ? "aborted" : maxTurnsReached ? "completed" : "failed",
            completedAt: new Date().toISOString(),
            telemetry: telemetry(maxTurnsReached ? "max-turns" : aborted ? "abort-requested" : "runtime-error"),
            ...(text ? { result: text } : {}),
            ...(!aborted && !maxTurnsReached
              ? { error: error instanceof Error ? error.message : String(error) }
              : {}),
          };
        } finally {
          unsubscribeInvocation();
        }

        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        if (cleanupError) result = { ...result, worktreeCleanupError: cleanupError };
        const persisted: SubagentResultMetadata = {
          version: 1,
          status: result.status as SubagentResultMetadata["status"],
          completedAt: result.completedAt!,
          ...(result.result ? { result: result.result } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(result.worktreeCleanupError ? { worktreeCleanupError: result.worktreeCleanupError } : {}),
          telemetry: result.telemetry,
        };
        appendSubagentResult(sessionManager, persisted);
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        return result;
      };

      const finishQueuedAbort = async () => {
        if (stored.run.status !== "queued") return;
        unsubscribeInvocation();
        const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString(), telemetry: telemetry("abort-requested") };
        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        const finalResult = cleanupError ? { ...result, worktreeCleanupError: cleanupError } : result;
        appendSubagentResult(sessionManager, { version: 1, status: "aborted", completedAt: finalResult.completedAt!, telemetry: finalResult.telemetry, ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}) });
        stored.run = finalResult;
        request.onUpdate?.(finalResult);
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        resolveCompletion(finalResult);
      };
      const queued = getSubagentQueue().enqueue(
        parentSessionId,
        readSubagentSettings().maxConcurrent,
        execute,
        (state) => {
          if (state === "queued") {
            sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
          }
          request.onUpdate?.({ ...stored.run, status: state });
          stored.run = { ...stored.run, status: state };
          dependencies.invalidateSessionList();
        },
        finishQueuedAbort,
      );
      stored.cancelQueued = queued.cancel;
      void queued.promise.then(resolveCompletion, (error) => {
        unsubscribeInvocation();
        const result: SubagentRunInfo = { ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), telemetry: telemetry("runtime-error") };
        appendSubagentResult(sessionManager, { version: 1, status: "failed", completedAt: result.completedAt!, error: result.error, telemetry: result.telemetry });
        stored.run = result;
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        resolveCompletion(result);
      });

      return { run: stored.run, completion: stored.completion };
    } catch (error) {
      if (isolatedWorktree) {
        try { await removeWorktree(parent.cwd, isolatedWorktree.path); } catch { /* preserve setup failure and avoid force deletion */ }
      }
      throw error;
    }
  }

  async function resume(request: ResumeSubagentRequest): Promise<SubagentExecution> {
    const choices = validateSubagentExecutionChoices(request);
    if (choices.inheritContext) throw new Error("Resume requires inherit_context: false and retains child history; start a new child for different inheritance/isolation");
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const existing = await get(request.sessionId);
    if (!existing) throw new Error(`Subagent not found: ${request.sessionId}`);
    if (existing.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    if (existing.status === "running" || existing.status === "queued") throw new Error("Subagent is already running");
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    const existingIsolation = existing.worktreePath ? "worktree" : "off";
    if (choices.isolation !== existingIsolation) throw new Error("Resume isolation must match the existing mode; start a new child for different inheritance/isolation");
    if (existing.worktreePath && !existsSync(existing.worktreePath)) throw new Error("Subagent worktree has been cleaned up; start a new child for different inheritance/isolation");
    const requestedModel = resolveSubagentExecutionModel(parent.inner.modelRuntime as ModelRuntime, choices);
    const sessionPath = existing.sessionPath || await dependencies.resolveSessionPath(request.sessionId);
    if (!sessionPath) throw new Error(`Subagent session file not found: ${request.sessionId}`);
    let wrapper = dependencies.getSession(request.sessionId);
    if (!wrapper?.isAlive()) wrapper = await dependencies.reopenSession(request.sessionId, sessionPath);
    if (!wrapper.isAlive()) throw new Error("Subagent session is no longer available");
    if (wrapper.isRunning()) throw new Error("Subagent is already running");

    // Validate all unsupported choices before reopening/setters/journal writes. The real
    // SDK model setter may apply model defaults; explicit effort must be applied AFTER it.
    await wrapper.inner.setModel(requestedModel);
    wrapper.inner.setThinkingLevel(choices.thinking);
    const { runInBackground, maxTurns: turnLimit } = choices;
    const initialRun: SubagentRunInfo = {
      ...existing,
      parentToolCallId: request.parentToolCallId,
      task: request.task,
      description: request.description.trim() || existing.description,
      runInBackground,
      status: "queued",
      completedAt: undefined,
      result: undefined,
      error: undefined,
      telemetry: undefined,
      resumed: true,
    };
    const manager = wrapper.inner.sessionManager;
    let turnCount = 0;
    let maxTurnsReached = false;
    let softLimitReached = false;
    const telemetry = (terminationReason: SubagentTelemetry["terminationReason"]): SubagentTelemetry => ({ turnCount, turnCountBasis: "turn_end", terminationReason });
    const unsubscribeTurns = wrapper.inner.subscribe((event) => {
      if (event.type !== "turn_end" || stored.run.status !== "running") return;
      turnCount += 1;
      if (!softLimitReached && turnCount >= turnLimit) {
        softLimitReached = true;
        void wrapper!.inner.steer("You have reached your turn limit. Wrap up immediately and provide your final answer now.");
      } else if (softLimitReached && turnCount >= turnLimit + 1) {
        maxTurnsReached = true;
        void wrapper!.inner.abort();
      }
    });
    let resolveCompletion!: (run: SubagentRunInfo) => void;
    const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
    const stored: StoredSubagentExecution = { run: initialRun, completion, abortRequested: false };
    getSubagentRuns().set(request.sessionId, stored);
    request.onUpdate?.(initialRun);
    dependencies.invalidateSessionList();
    const handleParentAbort = () => {
      stored.abortRequested = true;
      if (stored.run.status === "queued") stored.cancelQueued?.();
      else void wrapper!.inner.abort();
    };
    if (!runInBackground) {
      request.signal?.addEventListener("abort", handleParentAbort, { once: true });
      if (request.signal?.aborted) handleParentAbort();
    }
    const unsubscribeInvocation = () => {
      unsubscribeTurns();
      request.signal?.removeEventListener("abort", handleParentAbort);
    };

    const execute = async (): Promise<SubagentRunInfo> => {
      if (stored.abortRequested) {
        unsubscribeInvocation();
        const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString(), telemetry: telemetry("abort-requested") };
        appendSubagentResult(manager, { version: 1, status: "aborted", completedAt: result.completedAt!, telemetry: result.telemetry });
        stored.run = result;
        getSubagentRuns().delete(request.sessionId);
        resolveCompletion(result);
        return result;
      }
      stored.run = { ...stored.run, status: "running" };
      manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
      request.onUpdate?.(stored.run);
      let result: SubagentRunInfo;
      try {
        await wrapper!.inner.prompt(request.task, { source: "rpc" });
        const text = wrapper!.inner.getLastAssistantText()?.trim();
        const aborted = stored.abortRequested && !maxTurnsReached;
        const providerError = aborted ? undefined : lastAssistantError(manager);
        result = {
          ...initialRun,
          status: aborted ? "aborted" : providerError ? "failed" : "completed",
          completedAt: new Date().toISOString(),
          telemetry: telemetry(maxTurnsReached ? "max-turns" : aborted ? "abort-requested" : providerError ? "provider-error" : "completed"),
          ...(text ? { result: text } : {}),
          ...(providerError ? { error: providerError } : {}),
        };
      } catch (error) {
        const text = wrapper!.inner.getLastAssistantText()?.trim();
        const aborted = stored.abortRequested || request.signal?.aborted;
        result = {
          ...initialRun,
          status: aborted ? "aborted" : maxTurnsReached ? "completed" : "failed",
          completedAt: new Date().toISOString(),
          telemetry: telemetry(maxTurnsReached ? "max-turns" : aborted ? "abort-requested" : "runtime-error"),
          ...(text ? { result: text } : {}),
          ...(!aborted && !maxTurnsReached ? { error: error instanceof Error ? error.message : String(error) } : {}),
        };
      } finally {
        unsubscribeInvocation();
      }
      appendSubagentResult(manager, {
        version: 1,
        status: result.status as "completed" | "failed" | "aborted",
        completedAt: result.completedAt!,
        ...(result.result ? { result: result.result } : {}),
        ...(result.error ? { error: result.error } : {}),
        telemetry: result.telemetry,
      });
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(request.sessionId);
      dependencies.invalidateSessionList();
      return result;
    };
    const finishQueuedAbort = () => {
      if (stored.run.status !== "queued") return;
      unsubscribeInvocation();
      const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString(), telemetry: telemetry("abort-requested") };
      appendSubagentResult(manager, { version: 1, status: "aborted", completedAt: result.completedAt!, telemetry: result.telemetry });
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(request.sessionId);
      dependencies.invalidateSessionList();
      resolveCompletion(result);
    };
    const queued = getSubagentQueue().enqueue(parentSessionId, readSubagentSettings().maxConcurrent, execute, (state) => {
      if (state === "queued") manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
      stored.run = { ...stored.run, status: state };
      request.onUpdate?.(stored.run);
      dependencies.invalidateSessionList();
    }, finishQueuedAbort);
    stored.cancelQueued = queued.cancel;
    void queued.promise.then(resolveCompletion, (error) => {
      unsubscribeInvocation();
      const result: SubagentRunInfo = { ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), telemetry: telemetry("runtime-error") };
      appendSubagentResult(manager, { version: 1, status: "failed", completedAt: result.completedAt!, error: result.error, telemetry: result.telemetry });
      stored.run = result;
      getSubagentRuns().delete(request.sessionId);
      dependencies.invalidateSessionList();
      resolveCompletion(result);
    });
    return { run: stored.run, completion };
  }

  async function get(sessionId: string): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) return stored.run;
    const wrapper = dependencies.getSession(sessionId);
    if (wrapper?.isAlive()) {
      const run = readSubagentRun(
        wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        sessionId,
        wrapper.sessionFile,
      );
      if (run && wrapper.isRunning()) return { ...run, status: "running" };
      if (run) return settleOrphanedRun(run);
    }
    const sessionPath = await dependencies.resolveSessionPath(sessionId);
    if (!sessionPath) return null;
    const manager = SessionManager.open(sessionPath);
    const run = readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath);
    return run && settleOrphanedRun(run);
  }

  async function steer(sessionId: string, message: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  async function notifyParent(run: SubagentRunInfo): Promise<void> {
    globalThis.__piSubagentNotifications = (globalThis.__piSubagentNotifications ?? 0) + 1;
    try {
      await deliverParentNotification(run);
    } finally {
      globalThis.__piSubagentNotifications = Math.max(0, (globalThis.__piSubagentNotifications ?? 0) - 1);
    }
  }

  async function deliverParentNotification(run: SubagentRunInfo): Promise<void> {
    if (takeResultConsumed(run)) return;
    let parent = dependencies.getSession(run.parentSessionId);
    if (!parent?.isAlive()) {
      const sessionFile = await dependencies.resolveSessionPath(run.parentSessionId);
      if (!sessionFile) throw new Error(`Parent session not found: ${run.parentSessionId}`);
      parent = await dependencies.reopenSession(run.parentSessionId, sessionFile);
    }
    await parent.waitUntilReady();
    // The parent may still be inside the `get_subagent_result` call that collects this result,
    // and `deliverAs: "followUp"` would only queue the message until that turn ends anyway.
    // Hold the notification until the parent is idle and re-check the mark, so a result the
    // parent already consumed never triggers a duplicate turn.
    while (parent.isAlive() && parent.isRunning()) {
      if (takeResultConsumed(run)) return;
      await new Promise<void>((resolve) => { setTimeout(resolve, PARENT_IDLE_POLL_MS); });
    }
    if (takeResultConsumed(run)) return;
    if (!parent.isAlive()) throw new Error(`Parent session is no longer available: ${run.parentSessionId}`);
    await parent.inner.sendCustomMessage({
      customType: "pi-web:subagent-notification",
      content: subagentNotificationText(run),
      display: true,
      details: subagentToolDetails(run),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  async function abort(sessionId: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    const stored = getSubagentRuns().get(sessionId);
    if (stored?.run.status === "queued") {
      stored.abortRequested = true;
      if (!stored.cancelQueued?.()) throw new Error("Subagent is no longer queued");
      return;
    }
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (stored) stored.abortRequested = true;
    await wrapper.inner.abort();
  }

  return {
    extensionRuntime: { start, resume, get, steer, notifyParent, markResultConsumed },
    get,
    steer,
    abort,
  };
}
