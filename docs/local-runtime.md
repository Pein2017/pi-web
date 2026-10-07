# Local development runtime

The maintained checkout is `/data/CoordExp/codex-tools/pi-web`, based on
`agegr/pi-web` commit `6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068` (v0.10.0).
The maintained branch is `main` in the independent fork
`https://github.com/Pein2017/pi-web`. `origin` identifies that fork; `upstream`
fetches `https://github.com/agegr/pi-web.git` and has pushing disabled locally.
The initial fork setup also merged upstream commit
`038057f4797568394fd2a8f4a800e2e5d1bef071` without discarding local features.
Upstream updates require an explicit fetch, reviewed integration and revalidation;
publication and runtime adoption remain separate actions. Project ownership and
synchronization are documented in [fork maintenance](fork-maintenance.md), and
Pi Web's own OpenSpec root is this repository's `openspec/`.

Existing local changes to Simplified Chinese defaults and allowed development
origins were preserved. Web dependencies are retained in `node_modules/`;
its `@earendil-works` scope links to the official managed Pi release selected
under `/data/CoordExp/codex-tools/pi-core/.local/install`.
Web and terminal now share Pi 1.0.3.
The generated Next development cache is
rebuilt at the new path; do not run `next build` alongside the development server.

Pi Web and terminal Pi use one private profile at `/data/CoordExp/.pi`.
`bin/local-dev.sh` and `/data/CoordExp/bin/pi` explicitly select that directory;
`/root/.local/bin/pi` points to the latter wrapper, which executes the managed
Pi launcher at `/data/CoordExp/codex-tools/pi-core/.local/bin/pi`.
Shell startup exports
the same path. Session storage uses its default `<agent-dir>/sessions` without
a separate environment override. Existing project MCP entries at this root
remain the shared entries. No old profile is used as a fallback.

Web runtime files live in ignored, private `.local/`:

- `logs/dev.log`: current server and transport metadata log.
- `logs/before-migration.log`: previous server log.
- `recovery/`: pre-migration settings and the migration receipt.
  `pi-shared-root-20261005/` retains the retired Web and terminal profiles and
  a receipt for the shared-profile migration. They are recovery material only.
- `benchmarks/mcp-mode-20261005/`: existing benchmark artifacts with their original
  provenance retained.
- `tmp/`, `cache/`, `state/`, `npm-cache/`: generated runtime files.

All nine Web session files were retained. Five absolute `parentSession` links
were rebound to the migrated files; their message bytes were preserved. The old
session-list cache was retained only as recovery material and regenerated at the
new profile path.

The shared profile retains the current Web settings, latest per-provider OAuth
credential, existing root MCP entries, prior trust decisions and the union of
21 session IDs. Duplicate older histories were checked as prefixes of the
retained histories; message payloads were preserved and session path metadata
was rebound. Automatic retry and compaction remain enabled. The active
server-compaction module is now owned by the independent local repository
`/data/CoordExp/codex-tools/pi-extensions`, under `packages/pi-codex-compact`.
The shared profile selects a versioned, packaged runtime from that repository's
ignored `.local/releases/`; it loads generated `dist/index.ts` rather than editable
source or the official npm installation. Local release ownership and qualification
are documented in [local compaction](../../pi-extensions/docs/local-compaction.md).
The current credential-compatible protocol remains `context-management`.
Manual compaction waits for a prompt; active automatic compaction carries a task
continuation after the opaque checkpoint. Existing legacy compaction source and
diagnostic receipts remain at their original owners, outside active registration.
CodeGraph, Shared Memory, shared skills and the 9090 proxy retain
their existing owners. Node.js retains its existing owner; official Pi source
reference and the sole managed distribution now live under
`/data/CoordExp/codex-tools/pi-core`. The shared profile contains settings,
credentials, sessions and ancillary tools, independently of the installation.
The previous global npm CLI was already uninstalled by the terminal update.
`pi update` updates the managed installation. Web automatically adopts the
selected release after active tasks, queued work and terminal shells finish;
new CLI launches use it immediately. See [shared Pi runtime](shared-pi-runtime.md)
and [per-repository source indexes](pi-source-navigation.md).

Start one development server:

```bash
tmux new-session -d -s pi-web -c /data/CoordExp/codex-tools/pi-web \
  /data/CoordExp/codex-tools/pi-web/bin/local-dev.sh
tail -f /data/CoordExp/codex-tools/pi-web/.local/logs/dev.log
```

The launcher binds `127.0.0.1:12345`, explicitly selects the shared agent
profile and routes server HTTP(S) requests through `http://127.0.0.1:9090`.
`NO_PROXY` only exempts localhost and 127.0.0.1. It preserves the current public
allowed hostname `agegr.pein17.com`. SSH and Cloudflare configuration remain at
their existing owners.

Before restarting, inspect the listener and the named tmux pane, then gracefully
stop that exact launcher. Verify it exited before starting another server. The
transport observer logs connection destinations and OpenAI request error codes;
it records no request headers, credentials, bodies or prompts. A successful short
request proves that request only; proxy routing cannot guarantee upstream health
or sustained streaming reliability.

### Transport diagnostics

`bin/proxy-observation.cjs` owns the `[pi-web-transport]` JSON records in
`.local/logs/dev.log`. Version 2 correlates requests with connections and records
HTTP status, header latency, received byte totals, time since the last data,
socket endpoints/age and bounded error causes. It only allows the response
`x-request-id` header; request headers, query strings, bodies and arbitrary
error messages are excluded. Body chunks update counters without being logged.
The server RPC module also loads this observer, so development hot reload can
attach it without stopping running sessions. A process-wide guard prevents
duplicate subscriptions from preload and module reload.
An already-running version-1 preload can keep emitting unversioned records
until its next authorized restart; filter `version: 2` for the new diagnostics.

For proxy failures, correlate these records with the existing FRP server log at
`/var/log/pein-train-frps.log`. Its timestamps and the Web JSON timestamps use
UTC on this host; add eight hours for Beijing time. On 2026-10-06 the `9090`
proxy repeatedly closed and re-registered about every 185 seconds. At
11:18:48.514 and 11:21:52.675 UTC, FRP closed the proxy 2–3 ms before the
matching Web socket errors. The bounded receipt is
`.local/diagnostics/transport-20261006-01a11021/frp-correlation.json`.
This locates the observed interruption at the shared tunnel lifecycle; the
reason for the Mac client's repeated reconnects still needs its client log.

Installed Pi 1.0.3's `openai-responses` adapter always uses HTTP/SSE and ignores
the generic `transport` option. Its separate Codex adapter supports WebSocket,
but changing adapters requires checking endpoint/auth/model and compaction
behavior. A WebSocket would still traverse the same `9090` tunnel. Keep the
current route while diagnosing the tunnel; neither more retries nor longer
HTTP idle timeouts repairs a forced tunnel closure.

The local Web port changed from `30141` to `12345` on 2026-10-06 at the
user's request. Direct access on this server is `http://localhost:12345`.
The historical Mac/SSH/Cloudflare route below uses `30141`; an SSH forward
using that route must target this server's `12345` after this change.

## Phone browser access

Use `https://agegr.pein17.com/` and the existing Cloudflare Access login.
The route remains phone browser → Cloudflare Access/Tunnel → Mac local port
30141 → SSH forward → this server's port 30141.

On 2026-10-05, read-only Cloudflare checks confirmed `agegr-web` was healthy
with four active, non-pending connections on its Mac (`darwin_arm64`) connector.
The proxied CNAME points to that Tunnel, ingress selects `http://127.0.0.1:30141`,
and Access retains its single email-based Allow policy. The user confirmed the
phone browser opened the site and could operate it after login.

Origin checks with the public Host and browser/proxy headers returned HTTP 200
for the page, all 38 referenced script/style resources and the session API. A
public curl request reached the Access login redirect; a separate Python client
received HTTP 403, so anonymous-client checks are not interchangeable. No access
policy was relaxed. Sanitized snapshots are retained in
`.local/verification/cloudflare-*.json`; future health must be checked live.
