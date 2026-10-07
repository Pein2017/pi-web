# Pi Web OpenSpec

This directory is the planning and specification owner for **Pein2017/pi-web**.
It is not part of the ancestor CoordExp OpenSpec project and has no `store:`
pointer. Run commands from the Pi Web repository root, not its container folder.

```bash
cd /path/to/pi-web
openspec context --json   # root.path must be this repository
openspec list --json
openspec new change <change-name>
openspec status --change <change-name> --json
openspec instructions proposal --change <change-name> --json
```

Use the CLI's artifact dependency order and instructions for proposal, delta
specs, design and tasks. Review planning before implementation; then implement,
validate, and archive accepted changes through the normal OpenSpec workflow.
Stable specs describe accepted requirements, not aspirational features or an
inventory of unrelated uncommitted work.

- `config.yaml`: project context and project-specific artifact guidance.
- `specs/`: stable capability requirements after acceptance and synchronization.
- `changes/`: active changes and their archived lifecycle records.

Initialization used OpenSpec 1.13.0 with `--tools none`: no generated agent skills,
global prompt files or ancestor project configuration were overwritten. Current
harnesses can use their already-installed OpenSpec skills. A new machine can
optionally run `openspec init . --tools pi,codex` to install its local integrations;
inspect generated files and their ignore rules before committing them.

For a feature such as inline `$skill` multi-reference composition, create its
change here before implementing it. The fork bootstrap itself does not implement
that feature or claim that its acceptance tests passed.

See [fork maintenance](../docs/fork-maintenance.md) for upstream synchronization
and the distinction between Git publication and running-service adoption.
