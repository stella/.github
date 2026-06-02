## Repository Specifics

This repository owns organization-wide GitHub configuration for Stella: reusable workflows, composite actions, issue and PR templates, labels, branch-protection helpers, and the public organization profile.

### Working Rules

- Keep reusable workflows small and explicit; callers should be able to understand permissions, required secrets, and outputs from the workflow file itself.
- Prefer least-privilege `permissions` blocks and document any write permission in the workflow or action that needs it.
- Keep third-party actions pinned consistently with the repo existing pattern.
- Do not publish organization secrets, private infrastructure details, or internal incident context in templates, workflow logs, or profile copy.
- For profile changes, keep the copy short, public-facing, and grounded in the repositories that are actually visible.

### Checks

- Shell scripts: run `bash -n <script>` and the smallest practical smoke check.
- Workflows: inspect YAML carefully and prefer a focused PR when changing shared CI.
