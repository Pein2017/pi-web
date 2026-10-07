import assert from "node:assert/strict";
import * as diagnostics from "node:diagnostics_channel";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";

const source = await readFile(new URL("../bin/proxy-observation.cjs", import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const { Client } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("undici");

function observer({ realChannels = false, brokenConsole = false } = {}) {
  const subscriptions = [];
  const logs = [];
  let now = 1000;
  const clock = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const channelApi = {
    subscribe(name, handler) {
      subscriptions.push({ name, handler });
      if (realChannels) diagnostics.subscribe(name, handler);
    },
  };
  const sandbox = vm.createContext({
    console: { error(prefix, json) {
      if (brokenConsole) throw new Error("Console unavailable");
      assert.equal(prefix, "[pi-web-transport]");
      logs.push(JSON.parse(json));
    } },
    process: { pid: process.pid }, URL, Date: realChannels ? Date : clock,
  });
  const script = new vm.Script(`(function(require) { ${source}\n})`);
  function install() {
    script.runInContext(sandbox)((name) => name === "node:diagnostics_channel" ? channelApi : require(name));
  }
  install();
  return {
    logs, subscriptions, install,
    advance(ms) { now += ms; },
    publish(name, event) { for (const subscription of subscriptions.filter((entry) => entry.name === name)) subscription.handler(event); },
    cleanup() { for (const { name, handler } of subscriptions) if (realChannels) diagnostics.unsubscribe(name, handler); },
  };
}

test("metadata correlates request, headers and failure without leaking payloads or error strings", () => {
  const probe = observer();
  const request = { origin: "https://user:URL_SECRET@api.openai.com", path: "/v1/responses?token=QUERY_SECRET", method: "POST", body: "PROMPT_SECRET", headers: "Authorization: AUTH_SECRET" };
  const socket = Object.assign(new EventEmitter(), { localAddress: "127.0.0.1", localPort: 1234, remoteAddress: "127.0.0.1", remotePort: 9090, alpnProtocol: "http/1.1" });
  probe.publish("undici:request:create", { request });
  probe.advance(5);
  probe.publish("undici:client:connected", { connectParams: { hostname: "api.openai.com", port: "443", protocol: "https:", version: "h1" }, socket });
  probe.publish("undici:client:sendHeaders", { request, socket, headers: "Authorization: SEND_SECRET" });
  probe.advance(10);
  probe.publish("undici:request:headers", { request, response: { statusCode: 200, headers: [Buffer.from("x-request-id"), Buffer.from("req_safe_123"), Buffer.from("set-cookie"), Buffer.from("COOKIE_SECRET")] } });
  const beforeChunks = probe.logs.length;
  probe.publish("undici:request:bodyChunkReceived", { request, chunk: Buffer.from("BODY_SECRET") });
  assert.equal(probe.logs.length, beforeChunks, "body chunks must only update aggregate metadata");
  probe.advance(25);
  const cause = { name: "SocketError", code: "UND_ERR_SOCKET", message: "other side closed CREDENTIAL_SECRET", cause: { name: "SECRET_NAME", code: "SECRET_CODE", message: "SECRET_ERROR" } };
  probe.publish("undici:request:error", { request, error: { name: "TypeError", message: "terminated AUTH_SECRET", stack: "STACK_SECRET", cause } });
  socket.emit("close", true);
  const started = probe.logs.find((entry) => entry.event === "request");
  const headers = probe.logs.find((entry) => entry.event === "headers");
  const failed = probe.logs.find((entry) => entry.event === "error");
  assert.equal(started.version, 2);
  assert.equal(started.origin, "https://api.openai.com");
  assert.equal(started.path, "/v1/responses");
  assert.equal(headers.requestId, started.requestId);
  assert.equal(headers.upstreamRequestId, "req_safe_123");
  assert.equal(headers.ttfbMs, 15);
  assert.equal(failed.requestId, started.requestId);
  assert.equal(failed.connectionId, headers.connectionId);
  assert.equal(failed.phase, "body");
  assert.equal(failed.status, 200);
  assert.equal(failed.bytes, Buffer.byteLength("BODY_SECRET"));
  assert.equal(failed.idleMs, 25);
  assert.equal(failed.elapsedMs, 40);
  assert.equal(failed.errors[0].classification, "terminated");
  assert.equal(failed.errors[1].code, "UND_ERR_SOCKET");
  assert.equal(failed.errors[1].classification, "other_side_closed");
  assert.equal(probe.logs.find((entry) => entry.event === "socket_close").connectionId, failed.connectionId);
  assert.doesNotMatch(JSON.stringify(probe.logs), /SECRET|Authorization|set-cookie|STACK/);
});

test("re-evaluation installs one observer and request paths are fixed labels", () => {
  const probe = observer();
  const count = probe.subscriptions.length;
  probe.install();
  probe.install();
  assert.equal(probe.subscriptions.length, count);
  for (const path of ["/v1/models?token=SECRET", "/v1/chat/completions?token=SECRET", "/arbitrary/SECRET"]) {
    probe.publish("undici:request:create", { request: { origin: "https://api.openai.com", method: "GET", path } });
  }
  assert.deepEqual(probe.logs.map((entry) => entry.path), ["/v1/models", "/v1/chat/completions", "other"]);
  assert.equal(new Set(probe.logs.map((entry) => entry.requestId)).size, 3);
});

test("observer exceptions never escape into transport callbacks", () => {
  const probe = observer({ brokenConsole: true });
  assert.doesNotThrow(() => probe.publish("undici:request:create", { request: { origin: "https://api.openai.com", method: "GET", path: "/v1/models" } }));
  const request = {};
  Object.defineProperty(request, "origin", { get() { throw new Error("Getter failed"); } });
  assert.doesNotThrow(() => probe.publish("undici:request:create", { request }));
});

test("late installation preserves available metadata without inventing request timing", () => {
  const probe = observer();
  const request = { origin: "https://api.openai.com", method: "POST", path: "/v1/responses" };
  probe.publish("undici:request:headers", { request, response: { statusCode: 200, headers: [] } });
  probe.advance(10);
  probe.publish("undici:request:bodyChunkReceived", { request, chunk: Buffer.from("partial") });
  probe.advance(20);
  probe.publish("undici:request:error", { request, error: { name: "TypeError", message: "terminated" } });
  const headers = probe.logs.find((entry) => entry.event === "headers");
  const failed = probe.logs.find((entry) => entry.event === "error");
  assert.equal(failed.observedFromStart, false);
  assert.equal(headers.ttfbMs, undefined);
  assert.equal(failed.elapsedMs, undefined);
  assert.equal(failed.idleMs, undefined);
  assert.equal(failed.status, 200);
  assert.equal(failed.bytes, 7);
  assert.equal(headers.requestId, failed.requestId);
});

test("installed Undici records successful and truncated local streams through the production origin filter", async (t) => {
  const probe = observer({ realChannels: true });
  t.after(() => probe.cleanup());
  const partial = "PARTIAL_BODY_SECRET";
  const complete = "SUCCESS_BODY_SECRET";
  let partialSocket;
  const server = createServer((request, response) => {
    if (request.url.startsWith("/v1/responses")) {
      response.writeHead(200, { "content-length": Buffer.byteLength(partial) + 100, "x-request-id": "req_partial", "set-cookie": "RESPONSE_COOKIE_SECRET" });
      response.write(partial);
      partialSocket = response.socket;
    } else {
      response.writeHead(200, { "x-request-id": "req_success" });
      response.end(complete);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const client = new Client("https://api.openai.com", {
    allowH2: false, headersTimeout: 1000, bodyTimeout: 1000,
    connect(_options, callback) {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => callback(null, socket));
      socket.once("error", (error) => callback(error, null));
      return socket;
    },
  });
  t.after(async () => { await client.destroy(); await new Promise((resolve) => server.close(resolve)); });
  const success = await client.request({ method: "GET", path: "/v1/models?query=QUERY_SECRET", headers: { authorization: "Bearer AUTH_SECRET" } });
  assert.equal(await success.body.text(), complete);
  const failure = await client.request({ method: "POST", path: "/v1/responses?query=QUERY_SECRET", body: "PROMPT_SECRET", headers: { authorization: "Bearer AUTH_SECRET" } });
  // Start the idle interval only after the consumer has received the partial
  // body. Under concurrent test load a server-side timer can expire before the
  // client's data event, yielding a legitimate near-zero observed idle period.
  const iterator = failure.body[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.toString(), partial);
  const rejected = assert.rejects(iterator.next(), /other side closed|terminated|content length/i);
  await delay(25);
  partialSocket.destroy();
  await rejected;
  await delay(10);
  const completed = probe.logs.find((entry) => entry.event === "complete" && entry.path === "/v1/models");
  const failed = probe.logs.find((entry) => entry.event === "error" && entry.path === "/v1/responses");
  assert.ok(completed, "successful stream terminal metadata missing");
  assert.ok(failed, "truncated stream terminal metadata missing");
  assert.equal(completed.bytes, Buffer.byteLength(complete));
  assert.equal(failed.bytes, Buffer.byteLength(partial));
  assert.equal(failed.status, 200);
  assert.equal(failed.phase, "body");
  assert.ok(failed.elapsedMs >= 20);
  assert.ok(failed.idleMs >= 15);
  assert.ok(failed.errors.some((entry) => entry.code === "UND_ERR_SOCKET" || entry.code === "UND_ERR_RES_CONTENT_LENGTH_MISMATCH"));
  assert.ok(probe.logs.some((entry) => entry.event === "headers" && entry.requestId === failed.requestId && entry.upstreamRequestId === "req_partial"));
  assert.ok(probe.logs.some((entry) => entry.event === "socket_close" && entry.connectionId === failed.connectionId));
  assert.ok(probe.logs.some((entry) => entry.event === "connected" && entry.connectionId === failed.connectionId && entry.remotePort === port));
  assert.doesNotMatch(JSON.stringify(probe.logs), /SECRET|Bearer|set-cookie/);
});
