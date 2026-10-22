# Package quarantine checks

The reusable policy discovers every supported ecosystem in a repository: a root
`bun.lock`, a root `pnpm-lock.yaml`, and every tracked `Cargo.lock`. It runs all
applicable checks in one job. npm, Yarn, unlocked JavaScript manifests, and
unlocked Cargo manifests fail closed because they cannot be screened.

## Consumer configuration

### Bun

```toml
[install]
minimumReleaseAge = 432000
minimumReleaseAgeExcludes = [
  "@stll/example", # quarantine-excluded-since: 2026-01-01T00:00:00.000Z
]
```

Root `package.json` must contain an explicit `trustedDependencies` string array.
An empty array disables Bun's built-in lifecycle-script allowlist.

### pnpm

Pin `packageManager` to pnpm 10.16.0 or newer in root `package.json`, then add:

```yaml
minimumReleaseAge: 7200
minimumReleaseAgeExclude:
  - "@stll/example" # quarantine-excluded-since: 2026-01-01T00:00:00.000Z
onlyBuiltDependencies: []
```

`dangerouslyAllowAllBuilds` is forbidden. A repository `.npmrc` may not select a
non-default registry.

### Cargo

Every repository with a tracked `Cargo.lock` needs `.cargo/config.toml`:

```toml
[registry]
global-min-publish-age = "5 days"
```

It also needs `.cargo/quarantine.toml`, even when there are no exceptions:

```toml
# Crate versions admitted before the five-day quarantine.
excludes = [
  # "name@version", # quarantine-expires: 2026-01-01T00:00:00.000Z
]
```

Only crates.io sources are accepted. Path and workspace packages have no source
and are not screened.

## Exceptions and pruning

For a security hotfix, add the exact `"name@version"` with
`quarantine-expires:` set to its publication time plus five days. An expiry more
than five days after the check clock is rejected, preventing a standing bypass.
The hourly prune workflow removes the entry at that instant. First-party
`@stll/` packages and `stella-` or `stella_` crates instead use a bare name with
`quarantine-excluded-since:`.

On pull requests and merge groups, unchanged expired exceptions produce warning
annotations; new or changed exceptions and affected locked versions fail. A
missing or invalid trusted base fails closed. Main and scheduled checks fail on
all expired entries.

## Reusable workflows

Pin both reusable workflows to the same full commit SHA. Callers may choose a
self-hosted runner with the JSON-array `runs-on` input:

```yaml
jobs:
  quarantine:
    uses: stella/.github/.github/workflows/quarantine-policy.yml@0123456789abcdef0123456789abcdef01234567
    with:
      runs-on: '["self-hosted", "linux", "x64"]'
```

The default is `'["ubuntu-24.04"]'`. Policy callers retain `pull_request` and
`merge_group` triggers; prune callers retain one hourly schedule. A `push`
trigger, when present, must be restricted to `main`. Repositories outside the
`stella` organization do not need a prune caller; instead, add a `schedule`
trigger with exactly one hourly cron expression to the policy caller so expired
exceptions are still enforced promptly.
