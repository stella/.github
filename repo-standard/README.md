# Repository standard

This directory defines one repository baseline: `settings.json` enables auto-merge,
allows squash merges only, deletes merged branches, and configures squash messages;
`ruleset.json` defines the main-branch ruleset. Inventory entries may override the
default `ci-result` gate and `cla / cla` CLA contexts. Set `missingGate` to `true`
while a repository has no merge-queue gate; its gate context and merge-queue rule
are omitted, and the report lists it under `missing gate`.

Preview all settings and ruleset drift:

```sh
bun repo-standard/apply.ts --inventory <file> --dry-run
```

The preview exits 0 when every active repository is clean and 1 when it finds drift.
Apply the same baseline to explicitly selected repositories. `--repo` is repeatable,
and writes require a backup directory:

```sh
bun repo-standard/apply.ts --inventory <file> --repo <owner/name> --backup-dir <dir>
```

Without `--repo`, the command refuses to write; only `--dry-run` may cover the whole
inventory. Before each settings or ruleset write, the command backs up the current
repository settings or ruleset. Run it whenever this baseline changes and whenever a
repository is created. Archived, disabled, missing-gate, and inherited-ruleset
repositories are refused before their first write.
