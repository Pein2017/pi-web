# Pi source navigation

Each repository owns its `.codegraph` directory. Select that repository
explicitly for queries; `/data/CoordExp/codex-tools` is the container directory,
not an index owner. Runtime distributions, profile data, dependencies and caches
are excluded by each repository's ignore rules. The temporary Pi-only parent
index was removed so it cannot catch queries from other active repositories.

```bash
cd /data/CoordExp/codex-tools/pi-core
codegraph init --yes .
codegraph explore --path . "AgentSession automatic compaction"

cd /data/CoordExp/codex-tools/pi-web
codegraph init --yes .
codegraph explore --path . "startRpcSession"
```

The installed CLI is `/root/.codex-codegraph/node_modules/.bin/codegraph` if a
shell does not have it on PATH; `/root/.local/bin/codegraph` exposes that CLI.
MCP queries should explicitly select `projectPath` as either
`/data/CoordExp/codex-tools/pi-core`, `/data/CoordExp/codex-tools/pi-web`, or
`/data/CoordExp/codex-tools/pi-extensions`. Query both owners for a cross-module
question. `projectPath` selects the nearest index, not a query subtree.

- Official reference: `/data/CoordExp/codex-tools/pi-core`, tag `v1.0.3`,
  commit `d78dc83d633229d12f8b79631384c4c2717c399f`, fetch origin
  `https://github.com/earendil-works/pi.git`, push disabled. Tracked source
  is unmodified. Its private `.local` owns the managed installation.
- Maintained Web: `/data/CoordExp/codex-tools/pi-web`.
- Local compaction fork: `/data/CoordExp/codex-tools/pi-extensions`.

`pi update` updates the official distribution, independently of this reference
tag and Web source. Check the runtime version with `pi --version`; check the
reference with `git -C /data/CoordExp/codex-tools/pi-core describe --tags --exact-match`.
To align reference source after a future release, fetch its tag into this clean
reference, check out that tag, then run `codegraph sync /data/CoordExp/codex-tools/pi-core`.
This is source navigation, not a requirement to compile Pi or change core code.
Do not index `node_modules/@earendil-works`: those are generated runtime packages.
