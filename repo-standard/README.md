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
Apply the same baseline by omitting `--dry-run`:

```sh
bun repo-standard/apply.ts --inventory <file>
```

Run the command whenever this baseline changes and whenever a repository is created.
Archived and disabled repositories are reported and skipped.
