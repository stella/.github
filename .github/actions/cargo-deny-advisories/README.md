# Cargo deny advisories gate

This composite action runs the advisories check once and preserves cargo-deny's
normal fail-on-error behavior on `main`, schedules, and manual runs. When given a
base commit on a pull request or merge group, it fails only for error-severity
advisories affecting a `name@version` newly present in `Cargo.lock`. Advisories
for versions already in the base are always emitted as warning annotations.

The caller installs cargo-deny before invoking this action. Keep the other
cargo-deny checks separate:

```yaml
- name: Check dependency policy
  run: cargo deny check bans licenses sources
- name: Check advisories
  uses: stella/.github/.github/actions/cargo-deny-advisories@<reviewed-commit>
  with:
    base-sha: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
```

The optional `manifest-path`, `config`, and `lockfile` inputs default to
`Cargo.toml`, `deny.toml`, and `Cargo.lock`. A change event fails closed when its
base lockfile cannot be read or cargo-deny exits unsuccessfully without a
parseable advisory diagnostic.

Waivers remain native cargo-deny entries. Every entry must identify an owner and
an expiry in its reason:

```toml
[advisories]
ignore = [
  { id = "RUSTSEC-2026-0001", reason = "owner: platform expires: 2026-12-01" },
]
```

Missing metadata always fails. An expired waiver fails routine runs; on a change
event it warns only when the complete entry is unchanged from the base config.
