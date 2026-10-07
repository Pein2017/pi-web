# Shared managed Pi runtime

## Current installation

The user selected a shared 1.0.3 installation on 2026-10-05. Terminal Pi and
Pi Web now load that same official managed release and use `/data/CoordExp/.pi`.
On 2026-10-06 the installation moved to `codex-tools/pi-core/.local/install`;
the version remains 1.0.3. The old independent Web SDK 1.0.0 is retained as
recovery material only.

## Installation owner

The official managed installation at
`/data/CoordExp/codex-tools/pi-core/.local/install` owns Pi core
and its dependencies. Its `current-version` file selects a release. Terminal
`pi` executes `/data/CoordExp/codex-tools/pi-core/.local/bin/pi` through
`/data/CoordExp/bin/pi`. The launcher exports the canonical
`PI_MANAGED_INSTALL_ROOT`; `PI_CODING_AGENT_DIR=/data/CoordExp/.pi` remains
the shared profile. There is no old installation fallback.
Web can load the same release's SDK in its own server process; it does not need
to replace its in-process session API with a separate CLI/RPC implementation.

Before starting Web, `bin/use-shared-pi.cjs --activate` selects the current managed
release, validates the four public package identities and versions, and binds
Web's `node_modules/@earendil-works` to that release. The first independent Web
SDK directory is retained under `.local/recovery/shared-pi-runtime/`. Each binding
change records its selected release and previous binding there. Configuration,
credentials and sessions are not copied or rewritten by this helper.

Web's Pi requirements are optional peer dependencies supplied by the managed
installation. Its lock file no longer installs independent Pi packages; all
retained non-Pi dependency versions remain unchanged. `npm run dev` uses the
canonical `bin/local-dev.sh` launcher, which selects the shared profile, binds
the current managed SDK and puts `/data/CoordExp/bin/pi` first for terminal
commands. Web's unrelated dependencies retain their existing owners.

Next's Turbopack root and output tracing root both use `/data/CoordExp`, the
common ancestor of Web and the managed installation. Without this resolver
root, the external SDK link produced HTTP 500 during activation; matching both
roots restored the page and SDK-backed routes.

## Updates

`pi update` defaults to the official core updater. A successfully installed
release changes `current-version`; previously installed releases remain
available. New CLI processes load that selection; an existing interactive CLI
keeps its loaded release until reopened. `--extensions` updates configured
remote extensions, `--all` runs extension and core updates, and `--models`
refreshes catalogs. Local path packages, including our compaction release,
are skipped by extension updates and remain owned by their local release process.

The local dev launcher enables `PI_WEB_FOLLOW_MANAGED_PI=1`.
`lib/shared-pi-update.cjs` observes the selected version every two seconds.
Web retains its loaded release while sessions, preflight/setters, session
starts/binding/shutdown, queued inputs, subagents/held reports, or terminal
shells are busy. An open terminal shell must exit or close before adoption.
At idle, Web closes new work admission, gracefully disposes its idle sessions,
validates/activates the selected scope with `bin/use-shared-pi.cjs`, and exits
its Next dev worker with Next's restart code. The existing dev CLI restarts
the worker on the same port, loading fresh SDK modules. Browser event streams
reconnect and existing JSONL histories stay in the shared profile.

The observer survives HMR as one process-global gate and refreshes callbacks.
It logs `[pi-web:managed-update]` messages with loaded/selected versions and
wait/adoption/failure state. Validation/shutdown/activation failure prevents
restart and reopens admission on the retained release. This mechanism is
enabled only by the managed local dev launcher; packaged production Web does
not automatically exit. Source-reference tag and Web application source are
independent of core updates; see [source navigation](pi-source-navigation.md).

New SDK versions may still require Web adapter changes; shared installation
does not establish compatibility with every future upstream release.

The 2026-10-05 activation observations cover matching CLI/SDK version, shared
physical package path, Web process profile/PATH and basic page/session API
availability. No automated test suite or paid model request was run for this
installation change. Earlier cache diagnostic receipts used Web SDK 1.0.0 and
retain their historical scope; they are not measurements of the updated Web.

## Activation observations (2026-10-05)

- CLI version and Web's imported SDK version both reported `1.0.3`.
- Web's package scope resolves to
  `/data/CoordExp/.pi/install/releases/1.0.3/node_modules/@earendil-works`.
- The final Web listener is on `127.0.0.1:30141`; its process profile is
  `/data/CoordExp/.pi`, with no separate session-directory override, and its
  first `pi` on PATH is `/data/CoordExp/bin/pi`.
- After the resolver-root correction, `/`, `/api/sessions` and
  `/api/agent/running` returned HTTP 200. The session list contained 17 entries;
  the running-agent list was empty. This is HTTP/API availability evidence.
- `git diff --check` passed. No model-quality or cache-efficiency measurement
  was made. Private activation and recovery receipts remain under
  `.local/recovery/shared-pi-runtime/`.

## Relocation and adoption validation (2026-10-06)

The user confirmed the active Web work had finished before the owned dev CLI
was stopped. Installation and launcher were moved by same-filesystem rename;
their inodes were preserved. CLI and Web both use official release 1.0.3 from
the canonical scope. The observer is enabled on `127.0.0.1:12345`.
Profile/session preservation and HTTP checks are recorded privately in
`.local/recovery/shared-pi-location-20261006/`.

63 targeted tests passed both before and after cutover, including real isolated Next dev
adoption using test-owned external release generations, unchanged real Pi
SessionManager history, busy wait, synchronous admission, HMR deduplication,
held child reports and invalid binding retention. Typecheck and changed-file
lint passed. The isolated smoke does not establish future SDK API compatibility
or provider/model behavior; no paid model request or upstream core upgrade was
performed for this change. Qualification logs are in `.local/qualification/`.
