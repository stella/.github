# Package quarantine checks

On `pull_request` and `merge_group`, time-dependent failures apply to changed
quarantine configuration or newly locked package versions. Unchanged expired
exceptions emit GitHub warning annotations. The comparison uses the target base
checked out in `.quarantine-base`; a missing trusted base fails closed.

On main pushes and scheduled runs, expired exceptions fail immediately. The
prune workflow runs enforcement independently from preparing and opening or
updating the removal PR, so an enforcement failure does not block that PR.

Consumers pin both reusable workflows to the same full commit SHA. Keep the
policy caller's `pull_request` and `merge_group` triggers and the prune caller's
hourly schedule. To enable automatic pruning on main pushes, also add this
trigger to the consumer's `.github/workflows/quarantine-prune.yml`:

```yaml
on:
  push:
    branches: [main]
  schedule:
    - cron: "17 * * * *"
```

The policy caller can also declare `push` restricted to `main`. Existing callers
without `push` remain accepted; reusable workflows cannot add caller triggers.

Clock-dependent policy conditions are temporary-exception expiry, first-party
exclusion dates in the future, and npm's five-day publication-age cutoff
(including future publication timestamps). The previous 24-hour expiry grace
period is removed. Pruning selects temporary exceptions at their expiry instant.
The check functions require an injected clock; only CLI entry points read the
system clock. Registry retry delays and request timeouts bound I/O, rather than
changing the policy result with the calendar.
