// Observe transport metadata without logging credentials, headers or prompts.
const { subscribe } = require('node:diagnostics_channel');

function relevant(origin) {
  try {
    const url = new URL(String(origin));
    return url.hostname === 'api.openai.com' ||
      (url.hostname === '127.0.0.1' && url.port === '9090');
  } catch {
    return false;
  }
}

function log(event, fields) {
  console.error('[pi-web-transport]', JSON.stringify({
    time: new Date().toISOString(), pid: process.pid, event, ...fields,
  }));
}

subscribe('undici:client:connected', ({ connectParams }) => {
  if (connectParams.hostname === 'api.openai.com' ||
      (connectParams.hostname === '127.0.0.1' && String(connectParams.port) === '9090')) {
    log('connected', { host: connectParams.hostname, port: String(connectParams.port) });
  }
});

subscribe('undici:request:create', ({ request }) => {
  if (relevant(request.origin)) {
    log('request', { origin: String(request.origin), method: request.method });
  }
});

subscribe('undici:request:error', ({ request, error }) => {
  if (relevant(request.origin)) {
    const errors = [];
    for (let current = error; current && errors.length < 4; current = current.cause) {
      errors.push({ name: current.name, code: current.code });
    }
    log('error', { origin: String(request.origin), errors });
  }
});
