# Independently maintained Pi Web fork

## Ownership

- Fork: <https://github.com/Pein2017/pi-web>, GitHub fork of `agegr/pi-web`.
- Original author: <https://github.com/agegr/pi-web>; retain upstream license and
  attribution. Fork maintenance does not transfer upstream npm namespace ownership.
- Maintained/default branch: `main`, including our reviewed local features.
- Local checkout: `/data/CoordExp/codex-tools/pi-web`, a separate Git repository.
  Its parent directory is a host location, not its development/specification owner.
- Planning owner: this repository's `openspec/`. Confirm `openspec context --json`
  resolves to the Pi Web root before creating or changing artifacts.
- Pi Core, local extension repositories, the shared-memory service, and private
  credentials/session profiles have separate owners. Sharing an SDK/profile does
  not make their source or secrets part of this repository.

The local memory registry already recognizes this Git repository as project
`pi-web`. Future development sessions should start in the Pi Web root and use
that session's actual caller identity; an older parent-folder session is not
relabelled or retroactively moved by this bootstrap.

## Remotes

This checkout uses `origin` for the fork and `upstream` for the original author.
The upstream push URL is deliberately unusable and the default push remote is
`origin`. These are local Git settings, not settings inherited by another clone.
For a new clone:

```bash
git clone https://github.com/Pein2017/pi-web.git
cd pi-web
git remote add upstream https://github.com/agegr/pi-web.git
git remote set-url --push upstream no_push://agegr/pi-web
git config remote.pushDefault origin
git branch --set-upstream-to=origin/main main
```

Fetch does not modify working source or restart a service:

```bash
git fetch --no-tags upstream main
git log --oneline main..upstream/main
git diff --stat main...upstream/main
```

Fetching on request is supported; no periodic fetch, unattended merge, deployment
or GitHub synchronization job is installed by this setup.

## Reviewed upstream integration

First reconcile owners and save/commit only the relevant local feature batches.
Do not automatically stash/reset unrelated dirty work. Use a clean review branch
or separately authorized worktree when integration intersects in-progress files.
For a clean checkout, an ordinary review route is:

```bash
git switch main
git pull --ff-only origin main
git switch -c sync/upstream-YYYYMMDD
git merge --no-ff upstream/main
# Review conflicts and retained behavior; run affected checks.
# Open a PR explicitly against Pein2017/pi-web main when publication is authorized.
```

Use merge-based integration to retain both upstream ancestry and local commits.
Never use `reset --hard upstream/main`, force-push, or force-sync the fork to erase
our features. Do not rebase published `main`. A conflict requires preserving both
contracts or an explicit compatibility decision, not choosing all "theirs".
Feature branches (`feature/<name>`) and upstream-sync branches both return to
our `main`. Pushes and PRs target `Pein2017/pi-web`, not the original repository.

Use local OpenSpec for consequential multi-module features and integration
changes that alter contracts. Keep small fixes and mechanical updates bounded;
do not manufacture specifications for historical or unqualified dirty work.

## Qualification and runtime adoption

Select checks by affected caller/consumer: scoped `node:test` tests, TypeScript
checks and affected lint. Runtime/lifecycle changes additionally need their real
Web API/SDK/SSE consumer slice; a mock-only check does not prove hosted reliability.
Never run `next build` in the active dev checkout: it can corrupt `.next` used by
the running server. Restart/build/deploy only with the relevant authority.

GitHub stores committed source, not the current machine's complete runtime.
The local launcher uses a separately managed official SDK and a private profile;
see [local runtime](local-runtime.md) and [shared Pi runtime](shared-pi-runtime.md).
A new machine needs its own documented SDK/profile provisioning. Remote CI must
supply the declared optional Pi SDK peer packages; success with a local managed
SDK does not establish fresh-clone CI or turnkey installation.

Do not run the inherited `npm run release` to publish `@agegr/pi-web` as our fork.
Renaming packages, configuring releases or deploying GitHub Pages is a separate
change. Keep `.local/`, `node_modules/`, `.next/`, environment files, credentials,
private sessions and runtime links out of commits.

## Initial publication boundary (2026-10-07)

The bootstrap retains local commit `e6d7ae3` (shared managed Pi integration) and
merges upstream `038057f` (readable write-tool content) in merge commit `7756f7e`.
It adds only fork ownership and project-local OpenSpec configuration/docs.
Preexisting uncommitted subagent, statistics, diagnostics, runtime-update and UI
work is retained locally, not silently staged or qualified by this publication.

The upstream MessageView suite passed **32/32** against an index-exported source
snapshot, using existing installed dependencies, without changing dirty work.
Against the active working copy the same suite had 18 passes and 14 failures:
its English assertions encountered the preexisting uncommitted Chinese-default
locale behavior. The two new upstream write-display tests passed there too.
This bootstrap does not repair that independent locale/test-contract mismatch,
claim full-suite CI acceptance, or restart the service. Private raw checks remain
under `.local/tmp/fork-bootstrap/`.
