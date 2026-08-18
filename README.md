# stella/.github

Organization-wide GitHub configurations, reusable workflows, and templates.

## Contents

### Reusable Workflows

| Workflow | Description |
|----------|-------------|
| `pr-lint.yml` | PR linting: conventional commits, labels, auto-assign |
| `base-checks.yml` | Composite workflow calling pr-lint |
| `audit-branch-protection.yml` | Drift detection for GitHub rulesets (compliance evidence) |
| `ai-shared-update.yml` | Update the pinned `stella/ai-shared` submodule, regenerate consumers, and open a PR |
| `provenance-update.yml` | Reusable nightly/manual provenance refresh that opens a PR when `provenance/` drifts |
| `changeset-release-pr.yml` | Maintain a version-only Changesets PR with an app-scoped token |
| `npm-independent-release.yml` | Publish independently versioned npm monorepos from caller-built tarballs |

### Composite Actions

| Action | Description |
|--------|-------------|
| `typescript-checks` | Setup pnpm, install deps, run lint + format + typecheck |
| `notify-failure` | Send failure notification to Google Chat webhook |
| `provenance-check` | Install `stella/provenance` and verify committed provenance artifacts |
| `changeset-policy` | Require valid release intent for caller-declared package paths |
| `sync-cargo-workspace-lock` | Synchronize inherited Cargo workspace versions in Cargo.lock |

### Templates

- **PULL_REQUEST_TEMPLATE.md** - Standard PR template
- **ISSUE_TEMPLATE/** - Bug report, epic, feature request, other

### Label Definitions

- **labels.yml** - Standardized labels (reference for manual setup)

---

## Usage

### Base Checks (Recommended)

Use this composite workflow to run all standard checks:

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

permissions: write-all

jobs:
  checks:
    uses: stella/.github/.github/workflows/base-checks.yml@main
    secrets: inherit
```

### PR Lint

```yaml
# .github/workflows/pr-lint.yml
name: PR Lint

on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
    branches-ignore:
      - "dependabot/**"

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions: write-all

jobs:
  pr-lint:
    uses: stella/.github/.github/workflows/pr-lint.yml@main
    secrets: inherit
```

### Branch Protection Scripts

| Script | Description |
|--------|-------------|
| `apply-ruleset.sh` | Idempotent create/update of a GitHub ruleset from JSON |

---

### Audit Branch Protection

Compares live GitHub rulesets against a checked-in expected config
and uploads the result as a compliance artifact (365-day retention).
Detects drift and fails if the live config diverges from the
expected state.

```yaml
# .github/workflows/audit-branch-protection.yml
name: Audit Branch Protection

on:
  schedule:
    - cron: "0 8 * * 1" # Monday 08:00 UTC
  workflow_dispatch:

jobs:
  audit:
    uses: stella/.github/.github/workflows/audit-branch-protection.yml@main
    with:
      expected-config-path: .github/branch-protection/ruleset-main.json
    secrets:
      BRANCH_PROTECTION_APP_ID: ${{ secrets.BRANCH_PROTECTION_APP_ID }}
      BRANCH_PROTECTION_APP_KEY: ${{ secrets.BRANCH_PROTECTION_APP_KEY }}
```

**Secrets required:**
- `BRANCH_PROTECTION_APP_ID` — GitHub App ID with Administration: Read and write
- `BRANCH_PROTECTION_APP_KEY` — GitHub App private key (PEM)

**Inputs:**
- `expected-config-path` — path to the expected ruleset JSON (default: `.github/branch-protection/ruleset-main.json`)

### Provenance Update

Runs `provenance generate` in the calling repository and opens or updates
a pull request when checked-in `provenance/` artifacts drift. This workflow
never pushes directly to `main`.

The schedule must live in the calling repository.

```yaml
# .github/workflows/provenance-nightly.yml
name: Provenance Nightly

on:
  schedule:
    - cron: "0 2 * * *"
  workflow_dispatch:

jobs:
  provenance-update:
    permissions:
      contents: write
      pull-requests: write
    uses: stella/.github/.github/workflows/provenance-update.yml@<commit-sha>
    with:
      install-command: bun install --frozen-lockfile
      provenance-version: v0.1.2
    secrets: inherit
```

**Inputs:**
- `root` — repository root to scan (default: `.`)
- `node-version` — Node.js version used to install cdxgen (default: `22`)
- `cdxgen-version` — pinned `@cyclonedx/cdxgen` version (default: `12.1.5`)
- `install-syft` — install Syft before generation (default: `false`)
- `syft-version` — pinned Syft release tag (default: `v1.42.4`)
- `provenance-version` — GitHub release tag in `stella/provenance` to install (default: `v0.1.2`)
- `provenance-repository` — provenance repository slug (default: `stella/provenance`)
- `install-command` — optional dependency install command run before generation (default: `bun install --frozen-lockfile`)
- `branch` — branch used for refresh PRs (default: `chore/provenance-update`)
- `commit-message` — commit message for generated refreshes (default: `chore: refresh provenance artifacts`)
- `pr-title` — pull request title for generated refreshes (default: `chore: refresh provenance artifacts`)
- `pr-body` — pull request body for generated refreshes (default: `Automated provenance refresh generated by the shared nightly updater.`)

**Optional secrets:**
- `auth_token` — token for updater PR creation when downstream CI should run; if omitted, the workflow falls back to `github.token`

### AI shared updates

Consumer repositories keep `.ai/shared` pinned for reproducible CI, then call the
shared updater on a schedule. The updater fetches the selected `stella/ai-shared`
ref, rejects non-fast-forward changes, runs the fetched canonical sync script, and
opens or updates one PR containing the submodule pointer and every generated file.

```yaml
name: Update shared AI tooling

on:
  schedule:
    - cron: "17 7 * * 1"
  workflow_dispatch:

permissions:
  actions: write
  contents: write
  pull-requests: write

jobs:
  update:
    uses: stella/.github/.github/workflows/ai-shared-update.yml@<commit-sha>
    with:
      validation-workflow: ci.yml
```

The caller must enable GitHub Actions to create pull requests when relying on the
repository `GITHUB_TOKEN`. Alternatively, pass `auth_token`, or `app_id` plus
`app_private_key`, from a dedicated bot. A PAT or App token triggers normal PR CI;
the default-token path can explicitly dispatch a caller-selected workflow that
supports `workflow_dispatch`.

The updater checks out the caller without persisted credentials and does not mint
an optional App token until after the newly fetched sync script finishes. Consumer
CI and local commands continue to execute only the committed submodule revision.

### Changeset releases

Package repositories keep their source-path and version-synchronization rules local,
then delegate enforcement and version-PR maintenance to these shared contracts. Changesets
only prepares release metadata; the existing hardened release workflow remains the
sole publisher.

```yaml
jobs:
  changeset:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<commit-sha>
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: stella/.github/.github/actions/changeset-policy@<commit-sha>
        with:
          release-paths: |
            src/**
            crates/core/src/**
          generated-paths: |
            CHANGELOG.md
            VERSION
            Cargo.toml
            Cargo.lock
            package.json
            wasm/package.json
          package-files: |
            package.json

# In a separate push-to-main workflow:
jobs:
  version:
    uses: stella/.github/.github/workflows/changeset-release-pr.yml@<commit-sha>
    with:
      prepare-rust-wasm: true
      sync-cargo-inherited-lock: true
    secrets: inherit
```

The caller must provide `changeset`, `changeset:version`, and a `.changeset/config.json`.
The shared workflow serializes each target branch without interrupting an active
release mutation, and skips write-capable steps when its trigger commit is no longer
the branch head. A current no-op run closes any stale version PR and deletes its
generated branch, so queued runs converge without a duplicate release PR. Callers
should use matching workflow-level concurrency without cancellation; newer pushes
replace obsolete pending runs while the active mutation finishes.

For hybrid repositories, `changeset:version` must synchronize the selected package
version into every npm, Cargo manifest, Python, and central `VERSION` surface. With
`sync-cargo-inherited-lock` enabled, the shared workflow validates the incoming
lockfile and updates inherited local Cargo package entries inside the same Changesets
transaction, before the generated PR is committed. The version command must preserve
the committed Bun lockfile: deleting `bun.lock`/`bun.lockb` or running an unfrozen
`bun install` is rejected by the shared policy.

When a version command regenerates browser Wasm artifacts, `prepare-rust-wasm`
installs the `wasm32-unknown-unknown` target and the exact `wasm-bindgen` CLI version
resolved from the caller's locked Cargo workspace. The option is disabled by default
and expects the workspace at `cargo-manifest` to resolve exactly one `wasm-bindgen`
runtime version with all features enabled.

Repositories whose Cargo packages use `version.workspace = true` can validate or
repair the corresponding local `Cargo.lock` entries without maintaining a package
allowlist:

```yaml
- uses: stella/.github/.github/actions/sync-cargo-workspace-lock@<commit-sha>
  with:
    mode: check # use write while generating synchronized release metadata
```

The action discovers root workspace members with locked Cargo metadata, changes only
members that explicitly inherit `[workspace.package].version`, and leaves explicitly
versioned and registry packages untouched.

### Independent npm package releases

Independently versioned Changesets monorepos keep build and pack commands in their
own workflow, with no write credential or OIDC permission in that job. The privileged
job delegates the complete release transaction to the shared workflow:

```yaml
jobs:
  pack:
    permissions:
      contents: read
    # Build each public package, pack one .tgz, then upload one artifact per package.

  release:
    needs: pack
    permissions:
      contents: write
      id-token: write
    uses: stella/.github/.github/workflows/npm-independent-release.yml@<commit-sha>
    with:
      artifact-pattern: npm-tarball-*
      package-files: |
        packages/core/package.json
        packages/react/package.json
    secrets: inherit
```

The shared job validates an exact one-to-one mapping between the declared public
manifests and packed tarballs. It rejects unresolved `workspace:`, `catalog:`,
`link:`, and `file:` dependency specifiers, orders internal dependencies before
dependants, stages one draft release per `<name>@<version>`, publishes only versions
missing from npm, verifies the release asset against npm `dist.integrity`, then makes
the draft releases public. Existing complete versions are immutable no-ops. Safe
partial runs resume; registry-only versions are repaired with the registry artifact
and release notes that do not claim a local rebuild was the originally uploaded file.
Manual recovery can pass both `source-ref` and `artifact-run-id`; the shared workflow
accepts the earlier artifacts only when that run used the resolved source commit and
the same caller workflow path. Pass `environment` when `RELEASE_APP_PRIVATE_KEY` is an
environment secret; the release job then runs in that environment, so its deployment
policy decides which refs can mint the token.

Each package must have an adjacent `CHANGELOG.md` section headed `## <version>`.
Uploaded artifacts may include checksum files, but each must contain exactly one
`.tgz`; only that tarball becomes the corresponding GitHub release asset.

Trusted publishing is authorized against the **calling repository workflow filename**,
not `npm-independent-release.yml`. Keep that local filename stable and configure the
npm trusted publisher for it. Both the caller job and reusable workflow grant
`id-token: write`; no npm token is accepted. Optional `RELEASE_APP_ID` and
`RELEASE_APP_PRIVATE_KEY` secrets let protected tags and releases use a repository
GitHub App token.

Callers that pack a verified commit other than the triggering `github.sha` (for
example, a `workflow_run` gated on a promoted application release) pass that commit
as `source-ref`. The shared workflow resolves the ref once after checkout and uses
the resulting immutable SHA for package tag and release provenance.

### Apply Ruleset

Create or update a GitHub ruleset from a JSON file. Idempotent:
looks up by name, creates if missing, updates if found.

```bash
# Basic usage (from repository root)
.github/branch-protection/apply-ruleset.sh stella/stella \
  .github/branch-protection/ruleset-main.json

# With github-actions[bot] bypass (for SBOM workflow etc.)
.github/branch-protection/apply-ruleset.sh --github-actions-bypass \
  stella/stella .github/branch-protection/ruleset-main.json
```

---

## Composite Actions

### typescript-checks

Setup pnpm, install dependencies with caching, and run lint + format + typecheck.

```yaml
jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4

      - name: TypeScript Checks
        uses: stella/.github/actions/typescript-checks@main
```

**Inputs:**
- `run-lint` - Run `pnpm lint` (default: true)
- `run-format` - Run `pnpm format` (default: true)
- `run-typecheck` - Run `pnpm typecheck` (default: true)
- `run-codespell` - Run codespell spell checker (default: true)
- `working-directory` - Working directory (default: `.`)
- `node-version-file` - Node version file (default: `.nvmrc`)

### notify-failure

Send failure notification to Google Chat webhook.

```yaml
steps:
  - name: Build
    run: ./build.sh

  - name: Notify on failure
    if: failure()
    uses: stella/.github/actions/notify-failure@main
    with:
      webhook-url: ${{ secrets.GOOGLE_CHAT_WEBHOOK }}
      message: 'Failed to build service-name in production.'
```

### provenance-check

Install a pinned `stella/provenance` release binary and fail if committed
`provenance/` artifacts are stale.

```yaml
steps:
  - uses: actions/checkout@v6

  - name: Provenance
    uses: stella/.github/actions/provenance-check@main
    with:
      provenance-version: v0.1.2
```

**Inputs:**
- `root` - Repository root to scan (default: `.`)
- `node-version` - Node.js version used to install cdxgen (default: `22`)
- `cdxgen-version` - Pinned `@cyclonedx/cdxgen` version (default: `12.1.5`)
- `install-syft` - Install Syft for container provenance checks (default: `false`)
- `syft-version` - Pinned Syft release tag (default: `v1.42.4`)
- `provenance-version` - GitHub release tag in `stella/provenance` to install (default: `v0.1.2`)
- `provenance-repository` - Provenance repository slug (default: `stella/provenance`)
- `show-diff-on-failure` - Print `provenance diff` output on failure (default: `true`)
