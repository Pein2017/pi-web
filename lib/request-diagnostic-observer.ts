import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentSession, EventBus } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { DIAGNOSTIC_LIMITS, OBSERVATION_CHANNEL, rawResponseUsage, type RequestDiagnostics, type UnobservedReason } from "./request-diagnostics";

type Session = Pick<AgentSession, "sessionId" | "agent" | "modelRuntime">;
type Identity = { operationId: string; attemptId: string };
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;

/** API name alone is insufficient: custom implementations can reject or transform fetch. */
export function qualifiedResponsesAdapter(session: Session, model: Model<Api>): boolean {
  if (model.api !== "openai-responses") return false;
  const runtime = session.modelRuntime;
  if (runtime.getRegisteredNativeProvider(model.provider)) return false;
  if (runtime.getRegisteredProviderConfig(model.provider)?.streamSimple) return false;
  return true;
}

/** Public SDK surfaces only. The caller owns disposal on wrapper replacement/shutdown. */
export function installRequestDiagnostics(
  session: Session, bus: EventBus, host: RequestDiagnostics,
): () => void {
  let cleanup = () => {};
  const observer = host.attach(session.sessionId, () => cleanup());
  const original = session.agent.streamFunction;
  const unsubscribe = bus.on(OBSERVATION_CHANNEL, value => observer.observe(value));
  let disposed = false;
  const active = () => !disposed && observer.active();
  const emit = (value: object) => {
    if (!active()) return;
    try { bus.emit(OBSERVATION_CHANNEL, Object.freeze(value)); } catch { /* observational only */ }
  };
  const wrapped: StreamFn = (model, context, options) => {
    if (!active()) return original(model, context, options);
    const base = { version: 1 as const, sessionId: session.sessionId, provider: model.provider, api: model.api, model: model.id, kind: "unknown" as const };
    const unobserved = (reason: UnobservedReason, id: Identity = { operationId: "unknown", attemptId: "unknown" }) => emit({ ...base, ...id, phase: "unobserved", reason });
    let qualified = false;
    try { qualified = qualifiedResponsesAdapter(session, model); } catch { /* fail unqualified */ }
    if (!qualified || options?.fetch) {
      unobserved(options?.fetch ? "custom-fetch" : "unsupported-adapter");
      return original(model, context, options); // preserve options object, including Google/Vertex and custom fetch
    }
    let dispatches = 0;
    let first: Identity | undefined;
    let rawTerminals = 0;
    const terminal = (status: "completed" | "error" | "aborted", usage: ReturnType<typeof rawResponseUsage>, responseId?: unknown, identity?: Identity) => {
      const exact = identity ?? (dispatches === 1 ? first : undefined);
      emit({ ...base, ...(exact ?? { operationId: "unknown", attemptId: "unknown" }), phase: "terminal",
        status, usage,
        ...(typeof responseId === "string" && responseId.length <= 1024 ? { responseId } : {}),
      });
    };
    const delegate = globalThis.fetch;
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (!active()) return delegate(input, init);
      // Captured options also serve warming, and SDK retries call this again. Never reuse IDs.
      const id = { operationId: randomUUID(), attemptId: randomUUID() };
      dispatches++;
      if (dispatches === 1) first = id;
      try {
        const body = init?.body;
        if (typeof body !== "string") unobserved("body-unmaterialized", id);
        else if (body.length > DIAGNOSTIC_LIMITS.bodyBytes || Buffer.byteLength(body) > DIAGNOSTIC_LIMITS.bodyBytes) unobserved("body-oversized", id);
        else emit({ ...base, ...id, phase: "dispatch", coverage: "http-final", body });
      } catch { unobserved("observation-failed", id); }
      // Same arguments, original Response; do not clone, read, or tee its stream.
      return delegate(input, init).then(response => {
        if (!response.ok) terminal("error", rawResponseUsage(undefined), undefined, id);
        return response;
      }, error => {
        terminal(init?.signal?.aborted ? "aborted" : "error", rawResponseUsage(undefined), undefined, id);
        throw error;
      });
    };
    const onProviderStreamEvent: NonNullable<NonNullable<Parameters<StreamFn>[2]>["onProviderStreamEvent"]> = async (event, eventModel) => {
      try {
        const data = record(event);
        const response = record(data?.response);
        if (["response.completed", "response.failed", "response.incomplete"].includes(String(data?.type))) {
          rawTerminals++;
          terminal(data?.type === "response.completed" ? "completed" : "error", rawResponseUsage(response?.usage), response?.id);
        }
      } catch { unobserved("observation-failed"); }
      await options?.onProviderStreamEvent?.(event, eventModel);
    };
    const observeResult = (stream: Awaited<ReturnType<StreamFn>>) => {
      // result() observes completion without iterating/consuming the provider response or event queue.
      void stream.result().then(message => {
        if (dispatches === 0) unobserved("transport-unobserved");
        if (rawTerminals === 0) terminal(message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed", rawResponseUsage(undefined));
      }, () => {
        if (dispatches === 0) unobserved("transport-unobserved");
        if (rawTerminals === 0) terminal("error", rawResponseUsage(undefined));
      });
      return stream;
    };
    const result = original(model, context, { ...options, fetch, onProviderStreamEvent });
    return result instanceof Promise ? result.then(observeResult) : observeResult(result);
  };
  session.agent.streamFunction = wrapped;
  cleanup = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe(); observer.dispose();
    if (session.agent.streamFunction === wrapped) session.agent.streamFunction = original;
  };
  return cleanup;
}
