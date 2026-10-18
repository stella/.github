# npm-publish-hardened

Composite action that publishes a pre-packed npm tarball using **OIDC
trusted publishing** with **SLSA v1 provenance**. Refuses to fall back
to `NPM_TOKEN` auth and is idempotent over the tarball's contents.

## Why tarball-only

The publish-from-tarball flow lets the **exact same `.tgz`** that
goes to npm also be uploaded as a GitHub release asset. Downstream
users can then verify byte-for-byte that the artifact they install
from npm matches the public reference on GitHub.

The publish-from-directory flow (`cd dir && npm publish`) doesn't
give you that — npm packs in-memory and nothing intermediate is
exposed. So this action only supports tarballs; the caller is
responsible for the `npm pack` step and for uploading the same
tarball to the GitHub release.

## New-package preflight

Before publishing anything, the action verifies every package in the
queue already exists on the registry. Trusted publishing cannot create
a brand-new package (npm requires the package to exist before a
trusted publisher can be configured), so a first-ever publish would
otherwise fail late with an opaque `ENEEDAUTH` after sibling packages
already published. A missing package fails the run immediately with
bootstrap instructions:

1. `npm publish` a placeholder manually (e.g. `0.0.1-placeholder.0`
   with `--tag placeholder`),
2. add a trusted publisher in the package settings on npmjs.com
   (allow "publish"),
3. re-run the workflow.

Transient registry errors during the preflight only warn — the
publish loop has its own retries.

## What it does

1. Hard-fails if `NPM_TOKEN` or `NODE_AUTH_TOKEN` is in the
   environment. Trusted publishing is via OIDC token exchange; if a
   legacy token is present the publish would silently use it instead
   and defeat the purpose.
2. Verifies the npm CLI is v11.5.1+ (the cutoff for trusted
   publishing support).
3. Extracts `name@version` from the tarball's bundled
   `package/package.json` and skips publish if that exact version is
   already on the registry.
4. Runs `npm publish <tarball> --provenance --access public --tag
   <tag>`. npm detects the GitHub Actions OIDC env vars
   (`ACTIONS_ID_TOKEN_REQUEST_URL` and `_TOKEN`) and exchanges them
   for a one-shot registry token automatically.
5. Retries with exponential-ish backoff if publish reports failure
   but the version becomes visible (registry eventual consistency).

## Caller requirements

```yaml
permissions:
  id-token: write     # required for the OIDC exchange
  contents: read      # if the caller checks out the repo
  attestations: write # if the caller wants provenance attestations
                      # uploaded to GitHub as well
```

The calling job must have set up Node + npm 11.5.1+ before calling
the action. The standard pattern:

```yaml
- uses: actions/setup-node@<sha>  # v6
  with:
    node-version: "22.21.1"
    registry-url: https://registry.npmjs.org
- run: npm install --global npm@11
```

## One-time per-package configuration on npmjs.com

Trusted publishing also needs the npm side to know which repository
and workflow are allowed to publish:

1. Sign in to npmjs.com as a maintainer of the package.
2. Package settings → **Publishing access** → **Add trusted
   publisher**.
3. Select GitHub Actions. Fill in:
   - Organization: `stella`
   - Repository: e.g. `anonymize`
   - Workflow filename: `release.yml`
   - Environment: leave empty unless the caller uses a deployment
     environment (recommended for added gating)
4. Save.

Until that record exists for a package, the action will fail at
publish time with a 401.

## Usage

```yaml
- name: Pack
  id: pack
  run: |
    pack_json="$(npm pack --json --ignore-scripts --pack-destination release-artifacts)"
    tarball="$(echo "$pack_json" | jq -r '.[0].filename')"
    echo "tarball=release-artifacts/$tarball" >> "$GITHUB_OUTPUT"

- name: Publish
  uses: stella/.github/.github/actions/npm-publish-hardened@<sha>
  with:
    tarball: ${{ steps.pack.outputs.tarball }}
    # tag: latest    # default
```

## Inputs

| Name | Required | Default | Description |
| ---- | -------- | ------- | ----------- |
| `tarball` | one of `tarball` / `tarballs` | — | One packed `.tgz` |
| `tarballs` | one of `tarball` / `tarballs` | — | Newline-separated packed `.tgz` paths, in publication order |
| `tag` | no | `latest` | npm dist-tag |
| `expected-name` / `expected-version` | no | — | Exact identity required for a single tarball; set together |
| `publish-plan` | no | — | Ordered JSON plan for `tarballs`, described below |
| `npm-visibility-timeout-minutes` | no | `20` | Total visibility budget for the plan, greater than zero and at most 45 minutes |

## Dependency-aware plans

`publish-plan` contains one entry for each path in `tarballs`, in the same order:

```json
[
  {"name":"@example/core","version":"1.2.3","path":"core.tgz","dependencies":[]},
  {"name":"@example/ui","version":"2.0.0","path":"ui.tgz","dependencies":["@example/core"]}
]
```

`dependencies` lists packages in this plan; each must appear before its dependent.
The action validates the entire plan and checks every path before publication.
It passes each tarball and its expected identity to the hardened publisher, then
waits for that exact version to be visible on npm before continuing. All entries
share the configured visibility budget. The publisher
retains its token checks, provenance, retries, and integrity-bound idempotency.

Publication or visibility failure stops the plan. The failure message and
`skipped-dependents` output (a JSON array) name all remaining transitive dependents.
A rerun can reuse the plan: already published versions are checked for exact
integrity and skipped by the publisher before the visibility check.

The independent-release workflow builds the plan from packed manifests and checks
same-scope and planned dependency versions before creating tags or release drafts.
It omits versions already visible on npm when building a recovery plan.
