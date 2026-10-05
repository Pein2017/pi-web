# Local development runtime

The maintained checkout is `/data/CoordExp/codex-tools/pi-web`, based on
`agegr/pi-web` commit `6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068` (v0.10.0).
The maintained local branch is `main`; both `origin` and `upstream`
currently identify `https://github.com/agegr/pi-web.git`. Local development does
not publish to GitHub. Upstream updates require an explicit fetch, reviewed
integration and revalidation.

Existing local changes to Simplified Chinese defaults and allowed development
origins were preserved. Web dependencies are retained in `node_modules/`;
its `@earendil-works` scope links to the official managed Pi release selected
under `/data/CoordExp/.pi/install`. Web and terminal now share Pi 1.0.3.
The generated Next development cache is
rebuilt at the new path; do not run `next build` alongside the development server.

Pi Web and terminal Pi use one private profile at `/data/CoordExp/.pi`.
`bin/local-dev.sh` and `/data/CoordExp/bin/pi` explicitly select that directory;
`/root/.local/bin/pi` points to the latter wrapper, which executes the managed
Pi launcher at `/data/CoordExp/.pi/bin/pi`. Shell startup exports
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
server-compaction package is maintained local source at
`/data/CoordExp/codex-tools/pi-openai-server-compaction`; the pinned Git copy is
retained as original diagnostic/recovery material. The local repair uses
credential-compatible storage, proven response deltas and official opaque
compaction replay. See [cache diagnosis](cache-diagnosis-20261005.md).
CodeGraph, Shared Memory, shared skills and the 9090 proxy retain
their existing owners. Node.js and the Pi executables remain installed at their
existing locations. The user's concurrent terminal Pi update was reconciled:
managed CLI 1.0.3 lives in the shared profile's `install/`. The subsequent
user-requested runtime unification made Web load that same installation.
The previous global npm CLI was already uninstalled by the terminal update.
`pi update` updates the managed installation; restart Web afterward to load
the selected release. See [shared Pi runtime](shared-pi-runtime.md).

Start one development server:

```bash
tmux new-session -d -s pi-web -c /data/CoordExp/codex-tools/pi-web \
  /data/CoordExp/codex-tools/pi-web/bin/local-dev.sh
tail -f /data/CoordExp/codex-tools/pi-web/.local/logs/dev.log
```

The launcher binds `127.0.0.1:30141`, explicitly selects the shared agent
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
