/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preload needs native CommonJS. */
// Transport metadata only: never log request bodies, arbitrary headers or error text.
const observerKey = Symbol.for('pi-web.transport-observer.v2');
if (!globalThis[observerKey]) {
  const { subscribe } = require('node:diagnostics_channel');
  const { isIP } = require('node:net');
  const state = { requests: new WeakMap(), sockets: new WeakMap(), requestId: 0, connectionId: 0 };
  globalThis[observerKey] = state;

  function log(event, fields) {
    try {
      console.error('[pi-web-transport]', JSON.stringify({
        time: new Date().toISOString(), pid: process.pid, version: 2, event, ...fields,
      }));
    } catch { /* Diagnostics must never affect transport execution. */ }
  }
  function observe(channel, callback) {
    subscribe(channel, (event) => { try { callback(event); } catch { /* Metadata is best effort. */ } });
  }
  function origin(value) {
    const url = new URL(String(value));
    return url.hostname === 'api.openai.com' || (url.hostname === '127.0.0.1' && url.port === '9090')
      ? url.origin : undefined;
  }
  function endpoint(value) {
    const path = typeof value === 'string' ? value.split('?', 1)[0] : '';
    return ['/v1/responses', '/v1/models', '/v1/chat/completions'].includes(path) ? path : 'other';
  }
  function requestState(request, fromStart = false) {
    let entry = state.requests.get(request);
    if (entry) return entry;
    const safeOrigin = origin(request.origin);
    if (!safeOrigin) return;
    entry = {
      requestId: `r${++state.requestId}`, origin: safeOrigin, path: endpoint(request.path),
      method: ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method) ? request.method : 'other',
      observedFromStart: fromStart, startedAt: fromStart ? Date.now() : undefined, bytes: 0,
    };
    state.requests.set(request, entry);
    return entry;
  }
  function port(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 && number <= 65535 ? number : undefined;
  }
  function address(value) { return typeof value === 'string' && value.length <= 45 && isIP(value) ? value : undefined; }
  function connectionState(socket, params, fromStart = false) {
    if (!socket || (typeof socket !== 'object' && typeof socket !== 'function')) return;
    let entry = state.sockets.get(socket);
    if (entry) return entry;
    const alpn = ['h2', 'http/1.1'].includes(socket.alpnProtocol) ? socket.alpnProtocol : undefined;
    entry = {
      connectionId: `c${++state.connectionId}`, connectedAt: fromStart ? Date.now() : undefined,
      localAddress: address(socket.localAddress), localPort: port(socket.localPort),
      remoteAddress: address(socket.remoteAddress), remotePort: port(socket.remotePort),
      httpVersion: alpn === 'h2' || params?.version === 'h2' ? '2' :
        alpn === 'http/1.1' || params?.version === 'h1' ? '1.1' : undefined,
      alpn,
    };
    state.sockets.set(socket, entry);
    if (typeof socket.once === 'function') socket.once('close', (hadError) => {
      try { log('socket_close', { ...connectionFields(entry), hadError: hadError === true }); } catch { /* Best effort. */ }
    });
    return entry;
  }
  function connectionFields(entry) {
    if (!entry) return {};
    const { connectedAt, ...fields } = entry;
    return { ...fields, connectionAgeMs: connectedAt === undefined ? undefined : Math.max(0, Date.now() - connectedAt) };
  }
  function requestFields(entry) {
    return {
      requestId: entry.requestId, origin: entry.origin, method: entry.method, path: entry.path,
      observedFromStart: entry.observedFromStart, ...connectionFields(entry.connection),
    };
  }
  function terminalFields(entry) {
    const now = Date.now();
    return {
      ...requestFields(entry), status: entry.status, bytes: entry.bytes,
      phase: entry.bytes > 0 ? 'body' : entry.headersAt !== undefined ? 'headers' : 'before_headers',
      elapsedMs: entry.startedAt === undefined ? undefined : Math.max(0, now - entry.startedAt),
      idleMs: entry.observedFromStart ? Math.max(0, now - (entry.lastDataAt ?? entry.headersAt ?? entry.startedAt)) : undefined,
      lastDataAt: entry.lastDataAt === undefined ? undefined : new Date(entry.lastDataAt).toISOString(),
    };
  }
  function upstreamRequestId(headers) {
    if (!Array.isArray(headers)) return;
    for (let index = 0; index + 1 < Math.min(headers.length, 256); index += 2) {
      const name = headers[index];
      if (name?.length > 40 || String(name).toLowerCase() !== 'x-request-id') continue;
      const value = headers[index + 1];
      if (value?.length > 128) return;
      const text = String(value);
      return /^[A-Za-z0-9._:-]{1,128}$/.test(text) ? text : undefined;
    }
  }
  function errors(error) {
    const result = [];
    const names = ['Error', 'TypeError', 'AbortError', 'TimeoutError', 'SocketError', 'RequestAbortedError', 'HeadersTimeoutError', 'BodyTimeoutError', 'ConnectTimeoutError', 'ResponseContentLengthMismatchError', 'HTTPParserError'];
    const codes = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED'];
    for (let current = error; current && result.length < 4; current = current.cause) {
      const message = typeof current.message === 'string' ? current.message.slice(0, 256).toLowerCase() : '';
      const classification = message.includes('other side closed') ? 'other_side_closed' :
        message.includes('terminated') ? 'terminated' : message.includes('econnreset') ? 'connection_reset' :
        message.includes('econnrefused') ? 'connection_refused' : message.includes('socket hang up') ? 'socket_hang_up' :
        message.includes('timeout') || message.includes('timed out') ? 'timeout' : message.includes('abort') ? 'aborted' : 'other';
      result.push({ name: names.includes(current.name) ? current.name : 'other',
        code: codes.includes(current.code) ? current.code : undefined, classification });
    }
    return result;
  }

  observe('undici:request:create', ({ request }) => {
    const entry = requestState(request, true);
    if (entry) log('request', requestFields(entry));
  });
  observe('undici:client:connected', ({ connectParams, socket }) => {
    const host = connectParams.hostname;
    if (host !== 'api.openai.com' && !(host === '127.0.0.1' && String(connectParams.port) === '9090')) return;
    log('connected', { host, port: String(port(connectParams.port) ?? ''), ...connectionFields(connectionState(socket, connectParams, true)) });
  });
  observe('undici:client:sendHeaders', ({ request, socket }) => {
    const entry = requestState(request);
    if (!entry) return;
    entry.connection = connectionState(socket);
    log('send', requestFields(entry));
  });
  observe('undici:request:headers', ({ request, response }) => {
    const entry = requestState(request);
    if (!entry) return;
    entry.headersAt = Date.now();
    entry.status = Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599 ? response.statusCode : undefined;
    log('headers', { ...requestFields(entry), status: entry.status,
      ttfbMs: entry.startedAt === undefined ? undefined : Math.max(0, entry.headersAt - entry.startedAt),
      upstreamRequestId: upstreamRequestId(response.headers) });
  });
  observe('undici:request:bodyChunkReceived', ({ request, chunk }) => {
    const entry = requestState(request);
    if (!entry) return;
    const size = chunk?.byteLength;
    if (Number.isSafeInteger(size) && size > 0) {
      entry.bytes = Math.min(Number.MAX_SAFE_INTEGER, entry.bytes + size);
      entry.lastDataAt = Date.now();
    }
  });
  observe('undici:request:trailers', ({ request }) => {
    const entry = requestState(request);
    if (entry) log('complete', terminalFields(entry));
  });
  observe('undici:request:error', ({ request, error }) => {
    const entry = requestState(request);
    if (entry) log('error', { ...terminalFields(entry), errors: errors(error) });
  });
}
