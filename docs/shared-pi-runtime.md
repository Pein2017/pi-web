# Shared managed Pi runtime

## Current installation

The user selected a shared 1.0.3 installation on 2026-10-05. Terminal Pi and
Pi Web now load that same official managed release and use `/data/CoordExp/.pi`.
The old independent Web SDK 1.0.0 is retained as recovery material only.

## Installation owner

The official managed installation at `/data/CoordExp/.pi/install` owns Pi core
and its dependencies. Its `current-version` file selects a release. Terminal
`pi` already executes `/data/CoordExp/.pi/bin/pi` through the shared wrapper.
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

## Updates

`pi update` uses the official managed updater. A successfully installed release
changes `current-version`; previously installed releases remain available.
Restart Web after updating: its launcher rebinds to the selected release before
Node loads any SDK modules. An already-running Web process stays on its loaded
release until restart. Do not switch its SDK links during an active process.

New SDK versions may still require Web adapter changes; shared installation
does not establish compatibility with every future upstream release.

The 2026-10-05 activation observations cover matching CLI/SDK version, shared
physical package path, Web process profile/PATH and basic page/session API
availability. No automated test suite or paid model request was run for this
installation change. Earlier cache diagnostic receipts used Web SDK 1.0.0 and
retain their historical scope; they are not measurements of the updated Web.
