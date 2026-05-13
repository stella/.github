# npm-publish-hardened

Composite action that publishes a single npm package using **OIDC
trusted publishing** with **SLSA v1 provenance**. Refuses to fall
back to `NPM_TOKEN` auth and is idempotent over the package version.

## What it does

1. Hard-fails if `NPM_TOKEN` or `NODE_AUTH_TOKEN` is in the
   environment. Trusted publishing is via OIDC token exchange; if a
   legacy token is present the publish would silently use it instead
   and defeat the purpose.
2. Verifies the npm CLI is v11.5.1+ (the cutoff for trusted
   publishing support).
3. Skips publish if the exact `name@version` from `package.json` is
   already on the registry (re-runs of the same release are no-ops).
4. Runs `npm publish --provenance --access public --tag <tag>`. npm
   detects the GitHub Actions OIDC env vars
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
    node-version: "22"
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
- uses: stella/.github/.github/actions/npm-publish-hardened@<sha>
  with:
    package-dir: packages/anonymize
    # tag: latest    # default
```

## Inputs

| Name          | Required | Default  | Description                                                          |
| ------------- | -------- | -------- | -------------------------------------------------------------------- |
| `package-dir` | yes      | —        | Working directory containing the package's `package.json`            |
| `tag`         | no       | `latest` | npm dist-tag for the publish                                         |

## Why a composite action and not a reusable workflow

The publish step is what's actually shared across publishing repos.
Build/test scaffolding diverges (napi-rs cross-compilation,
TypeScript bundling, etc.) and a full reusable workflow would need
30+ inputs to handle every shape. Composite keeps the scope tight to
the part that's identical across all callers.
