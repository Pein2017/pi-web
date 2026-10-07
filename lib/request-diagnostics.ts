import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { BoundedDiagnosticSink, DIAGNOSTIC_LIMITS, privateRotatingWriter } from "./request-diagnostic-sink";
import { join } from "node:path";
export { BoundedDiagnosticSink, DIAGNOSTIC_LIMITS, privateRotatingWriter } from "./request-diagnostic-sink";

export const OBSERVATION_CHANNEL = "pi:request-observation:v1";
export const UNOBSERVED_REASONS = Object.freeze([
  "unsupported-adapter", "custom-fetch", "transport-unobserved", "body-unmaterialized",
  "body-oversized", "observation-failed", "attribution-unknown",
] as const);
export type UnobservedReason = typeof UNOBSERVED_REASONS[number];
export type DiagnosticUsage = Readonly<{
  cachedTokensState: "absent" | "zero" | "value" | "invalid";
  cachedTokens?: number; inputTokens?: number; outputTokens?: number;
}>;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
function snapshot(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  const source = object(value);
  if (!source) return;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (descriptor && !("value" in descriptor)) throw new Error("diagnostic-accessor");
    result[field] = descriptor?.value;
  }
  return result;
}
const bounded = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && Buffer.byteLength(value) <= 1024;

/** Detached primitive values only; no fabricated normalized zeros for missing raw fields. */
export function rawResponseUsage(raw: unknown): DiagnosticUsage {
  const usage = object(raw);
  const details = object(usage?.input_tokens_details);
  const cached = details?.cached_tokens;
  const present = details !== undefined && Object.hasOwn(details, "cached_tokens");
  return Object.freeze({
    cachedTokensState: !present ? "absent" : !count(cached) ? "invalid" : cached === 0 ? "zero" : "value",
    ...(present && count(cached) ? { cachedTokens: cached } : {}),
    ...(count(usage?.input_tokens) ? { inputTokens: usage.input_tokens } : {}),
    ...(count(usage?.output_tokens) ? { outputTokens: usage.output_tokens } : {}),
  });
}
function detachedUsage(value: unknown): DiagnosticUsage | undefined {
  const usage = snapshot(value, ["cachedTokensState", "cachedTokens", "inputTokens", "outputTokens"]);
  if (!usage || !["absent", "zero", "value", "invalid"].includes(usage.cachedTokensState as string)) return;
  const state = usage.cachedTokensState as DiagnosticUsage["cachedTokensState"];
  if (state === "zero" && usage.cachedTokens !== 0) return;
  if (state === "value" && (!count(usage.cachedTokens) || usage.cachedTokens === 0)) return;
  if ((state === "absent" || state === "invalid") && usage.cachedTokens !== undefined) return;
  if (usage.inputTokens !== undefined && !count(usage.inputTokens)) return;
  if (usage.outputTokens !== undefined && !count(usage.outputTokens)) return;
  return Object.freeze({ cachedTokensState: state,
    ...(count(usage.cachedTokens) ? { cachedTokens: usage.cachedTokens } : {}),
    ...(count(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
    ...(count(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
  });
}
export interface DiagnosticSession {
  observe(value: unknown): void;
  dispose(): void;
  active(): boolean;
}

/** Process-local privacy epoch. All producer metadata is untrusted, including identifiers. */
export class RequestDiagnostics {
  readonly epoch = randomUUID();
  private key = randomBytes(32);
  private sessions = new Map<string, { generation: string; onRelease?: () => void }>();
  private attempts = new Map<string, { session: string; operation: string; provider: string; api: string; model: string; kind: unknown }>();
  private rejected = 0;
  private evicted = 0;
  constructor(readonly sink: BoundedDiagnosticSink) {}
  stats() { return { sessions: this.sessions.size, attempts: this.attempts.size, rejected: this.rejected, evicted: this.evicted }; }
  fingerprint(value: string) { return createHmac("sha256", this.key).update(value).digest("hex"); }
  private remove(session: string) {
    const previous = this.sessions.get(session);
    this.sessions.delete(session);
    for (const [id, entry] of this.attempts) if (entry.session === session) this.attempts.delete(id);
    try { previous?.onRelease?.(); } catch { /* diagnostic cleanup only */ }
  }
  attach(sessionId: string, onRelease?: () => void): DiagnosticSession {
    const session = this.fingerprint(sessionId);
    this.remove(session);
    if (this.sessions.size >= DIAGNOSTIC_LIMITS.sessions) {
      this.remove(this.sessions.keys().next().value!); this.evicted++;
    }
    const generation = randomUUID(); this.sessions.set(session, { generation, onRelease });
    const active = () => this.sessions.get(session)?.generation === generation;
    return {
      active,
      observe: value => {
        if (!active()) return;
        try { this.observe(sessionId, session, generation, value); } catch { this.rejected++; }
      },
      dispose: () => { if (active()) this.remove(session); },
    };
  }
  private bodyRecord(body: string) {
    const summary: Record<string, unknown> = { bytes: Buffer.byteLength(body), hmac: this.fingerprint(body), parsed: false };
    try {
      const parsed = object(JSON.parse(body));
      if (!parsed) return summary;
      summary.parsed = true;
      const sections: Record<string, unknown> = {};
      for (const name of ["instructions", "tools", "input", "prompt_cache_key", "prompt_cache_retention", "store", "tool_choice"]) {
        if (!Object.hasOwn(parsed, name)) continue;
        const text = JSON.stringify(parsed[name]);
        sections[name] = { bytes: Buffer.byteLength(text), hmac: this.fingerprint(text) };
      }
      summary.sections = sections;
      if (Array.isArray(parsed.input)) {
        summary.inputCount = parsed.input.length;
        let prefix = "";
        summary.input = parsed.input.slice(0, 32).map(item => {
          const text = JSON.stringify(item);
          prefix = this.fingerprint(prefix + "\n" + text);
          return { bytes: Buffer.byteLength(text), hmac: this.fingerprint(text), prefix };
        });
        summary.inputOmitted = Math.max(0, parsed.input.length - 32);
      }
    } catch { summary.parsed = false; }
    return summary;
  }
  private observe(sessionId: string, session: string, generation: string, value: unknown) {
    const event = snapshot(value, ["version", "sessionId", "operationId", "attemptId", "provider", "api", "model", "kind", "phase", "body", "coverage", "reason", "usage", "status", "responseId"]);
    if (!event || event.version !== 1 || event.sessionId !== sessionId ||
      !["dispatch", "terminal", "unobserved"].includes(event.phase as string) ||
      !["unknown", "compaction"].includes(event.kind as string) ||
      ![event.sessionId, event.operationId, event.attemptId, event.provider, event.api, event.model].every(bounded)) {
      this.rejected++; return;
    }
    const operation = this.fingerprint(event.operationId as string);
    const attempt = this.fingerprint(event.attemptId as string);
    const provider = this.fingerprint(event.provider as string);
    const api = this.fingerprint(event.api as string);
    const model = this.fingerprint(event.model as string);
    const record: Record<string, unknown> = {
      version: 1, epoch: this.epoch, observerGeneration: generation, phase: event.phase, sessionId: session, operationId: operation,
      attemptId: attempt, provider, api, model, kind: event.kind,
    };
    if (event.phase === "dispatch") {
      if (event.attemptId === "unknown" || this.attempts.has(attempt)) { this.rejected++; return; }
      if (event.coverage !== "http-final" && event.coverage !== "unknown") { this.rejected++; return; }
      if (typeof event.body !== "string") { record.phase = "unobserved"; record.reason = "body-unmaterialized"; }
      else if (event.body.length > DIAGNOSTIC_LIMITS.bodyBytes || Buffer.byteLength(event.body) > DIAGNOSTIC_LIMITS.bodyBytes) {
        record.phase = "unobserved"; record.reason = "body-oversized";
      } else {
        record.coverage = event.coverage; record.body = this.bodyRecord(event.body);
        if (this.attempts.size >= DIAGNOSTIC_LIMITS.attempts) { this.attempts.delete(this.attempts.keys().next().value!); this.evicted++; }
        this.attempts.set(attempt, { session, operation, provider, api, model, kind: event.kind });
      }
    } else if (event.phase === "unobserved") {
      if (!UNOBSERVED_REASONS.includes(event.reason as UnobservedReason)) { this.rejected++; return; }
      record.reason = event.reason;
    } else {
      const usage = detachedUsage(event.usage);
      if (!usage || !["completed", "error", "aborted"].includes(event.status as string)) { this.rejected++; return; }
      const tracked = this.attempts.get(attempt);
      const exact = event.attemptId !== "unknown" && tracked?.session === session &&
        tracked.operation === operation && tracked.provider === provider && tracked.api === api && tracked.model === model && tracked.kind === event.kind;
      record.attribution = exact ? "exact" : "unknown";
      record.attemptId = exact ? attempt : "unknown";
      record.status = event.status; record.usage = usage;
      if (event.responseId !== undefined) {
        if (!bounded(event.responseId)) { this.rejected++; return; }
        record.responseId = this.fingerprint(event.responseId);
      }
      if (exact) this.attempts.delete(attempt);
    }
    record.tracking = this.stats();
    this.sink.enqueue(record);
  }
}

type DiagnosticGlobals = typeof globalThis & { __piRequestDiagnosticsV1?: RequestDiagnostics };
export function hostRequestDiagnostics(): RequestDiagnostics | undefined {
  if (process.env.PI_WEB_REQUEST_DIAGNOSTICS !== "1") return;
  const globals = globalThis as DiagnosticGlobals;
  return globals.__piRequestDiagnosticsV1 ??= new RequestDiagnostics(new BoundedDiagnosticSink(
    privateRotatingWriter(join(process.cwd(), ".local", "diagnostics")),
  ));
}
