import { describe, expect, test } from "bun:test";

import { validateReleaseWorkflow } from "./check";

const ref = "1".repeat(40);
const base = `name: Release
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${"2".repeat(40)}
      - run: npm pack
  publish-pypi:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: stella/.github/.github/actions/pypi-publish-hardened@${ref}
        with:
          project-name: example
          distribution-name: example
          expected-version: 1.2.3
          wheel-contract: '{}'
  finalize:
    uses: stella/.github/.github/workflows/npm-version-finalize.yml@${ref}
    permissions:
      contents: write
      id-token: write
    secrets:
      RELEASE_APP_ID: \${{ secrets.RELEASE_APP_ID }}
`;

describe("release policy", () => {
  test("accepts artifact-only publishers and unprivileged builds", () => {
    expect(() => validateReleaseWorkflow(base, ref)).not.toThrow();
  });

  test("accepts additional explicit release inputs", () => {
    const workflow = base.replace(
      "  workflow_dispatch:\n",
      "  push:\n    branches: [main]\n    paths: [VERSION, packages/data/package.json]\n  workflow_dispatch:\n",
    );
    expect(() => validateReleaseWorkflow(workflow, ref)).not.toThrow();
  });

  test("accepts the shared independently versioned npm publisher", () => {
    const workflow = base.replace(
      /  finalize:[\s\S]*$/,
      `  release:\n    uses: stella/.github/.github/workflows/npm-independent-release.yml@${ref}\n    permissions:\n      actions: read\n      contents: write\n      id-token: write\n`,
    );
    expect(() => validateReleaseWorkflow(workflow, ref)).not.toThrow();
  });

  test.each([
    ["workflow OIDC", base.replace("contents: read\njobs:", "contents: read\n  id-token: write\njobs:")],
    ["public comment trigger", base.replace("  workflow_dispatch:", "  workflow_dispatch:\n  issue_comment:")],
    ["release push without paths", base.replace("  workflow_dispatch:\n", "  push:\n    branches: [main]\n    paths: []\n  workflow_dispatch:\n")],
    ["workflow environment", base.replace("permissions:", "env:\n  BASH_ENV: artifact/payload\npermissions:")],
    ["workflow defaults", base.replace("permissions:", "defaults:\n  run:\n    shell: ./payload\npermissions:")],
    ["mutable action", base.replace("actions/checkout@" + "2".repeat(40), "actions/checkout@main")],
    ["publisher command", base.replace("    steps:\n      - uses: stella/.github/.github/actions/pypi", "    steps:\n      - run: npm install\n      - uses: stella/.github/.github/actions/pypi")],
    ["publisher ref drift", base.replaceAll(ref, "3".repeat(40))],
    ["secret inheritance", base.replace("    secrets:\n      RELEASE_APP_ID: \${{ secrets.RELEASE_APP_ID }}", "    secrets: inherit")],
    ["unexpected secret", base.replace("RELEASE_APP_ID }}", "NPM_TOKEN }}")],
    ["approved secret in a build", base.replace("      - run: npm pack", "      - run: npm pack\n        env:\n          TOKEN: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}")],
    ["extra write grant", base.replace("      id-token: write\n    steps:", "      id-token: write\n      packages: write\n    steps:")],
    ["privileged container", base.replace("    permissions:\n      id-token: write", "    container: attacker/image\n    permissions:\n      id-token: write")],
    ["privileged job environment", base.replace("    permissions:\n      id-token: write", "    env:\n      ATTACK: yes\n    permissions:\n      id-token: write")],
  ])("rejects %s", (_name, workflow) => {
    expect(() => validateReleaseWorkflow(workflow, ref)).toThrow();
  });
});
