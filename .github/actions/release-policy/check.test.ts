import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRepositoryFileWithin, validateReleaseWorkflow } from "./check";

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
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@${"4".repeat(40)}
        with:
          bun-version: 1.4.0
      - uses: actions/setup-node@${"3".repeat(40)}
        with:
          node-version: 22.21.1
      - run: npm pack
  publish-pypi:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' && (true)
    permissions:
      id-token: write
    steps:
      - uses: stella/.github/.github/actions/pypi-publish-hardened@${ref}
        with:
          project-name: example
          distribution-name: example
          expected-version: 1.2.3
          wheel-contract: '{"python-wheel-linux":["manylinux_2_17_x86_64"]}'
  finalize:
    if: github.ref == 'refs/heads/main' && (true)
    uses: stella/.github/.github/workflows/npm-version-finalize.yml@${ref}
    with:
      package-files: package.json
    permissions:
      contents: write
      id-token: write
    secrets:
      RELEASE_APP_ID: \${{ secrets.RELEASE_APP_ID }}
      RELEASE_APP_PRIVATE_KEY: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}
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

  test("accepts an exact Bun packageManager as the version source", () => {
    const workflow = base.replace("bun-version: 1.4.0", "bun-version-file: package.json");
    expect(() =>
      validateReleaseWorkflow(workflow, ref, (path) => {
        expect(path).toBe("package.json");
        return JSON.stringify({ packageManager: "bun@1.4.0" });
      }),
    ).not.toThrow();
  });

  test.each([
    "bun@latest",
    "bun@^1.4.0",
    "bun@1.4",
    "bun@1.4.0-canary",
    "prefix-bun@1.4.0",
  ])(
    "rejects non-exact packageManager %s",
    (packageManager) => {
      const workflow = base.replace("bun-version: 1.4.0", "bun-version-file: package.json");
      expect(() =>
        validateReleaseWorkflow(workflow, ref, () => JSON.stringify({ packageManager })),
      ).toThrow();
    },
  );

  test("rejects Bun manifests that escape the repository", () => {
    const workflow = base.replace("bun-version: 1.4.0", "bun-version-file: ../package.json");
    expect(() =>
      validateReleaseWorkflow(workflow, ref, () =>
        JSON.stringify({ packageManager: "bun@1.4.0" }),
      ),
    ).toThrow();
  });

  test.each([
    "",
    `      - uses: actions/checkout@${"2".repeat(40)}\n        with:\n          persist-credentials: false\n      - uses: actions/checkout@${"2".repeat(40)}\n`,
    "      - run: node scripts/rewrite-package.mjs\n",
    `      - uses: ./mutable-local-action\n`,
    `      - uses: owner/mutable-composite@${"5".repeat(40)}\n`,
  ])("rejects a Bun version file without one immediately preceding checkout", (step) => {
    const workflow = base
      .replace("bun-version: 1.4.0", "bun-version-file: package.json")
      .replace(
        `      - uses: actions/checkout@${"2".repeat(40)}\n        with:\n          persist-credentials: false\n`,
        step,
      );
    expect(() =>
      validateReleaseWorkflow(workflow, ref, () =>
        JSON.stringify({ packageManager: "bun@1.4.0" }),
      ),
    ).toThrow();
  });

  test.each(["repository", "ref", "path", "github-server-url"])(
    "rejects checkout input %s before a Bun version file",
    (input) => {
      const workflow = base
        .replace("bun-version: 1.4.0", "bun-version-file: package.json")
        .replace(
          "          persist-credentials: false",
          `          persist-credentials: false\n          ${input}: untrusted`,
        );
      expect(() =>
        validateReleaseWorkflow(workflow, ref, () =>
          JSON.stringify({ packageManager: "bun@1.4.0" }),
        ),
      ).toThrow();
    },
  );

  test.each([
    "        if: false\n",
    "        continue-on-error: true\n",
    "        env:\n          INPUT_REPOSITORY: untrusted/example\n",
  ])(
    "rejects checkout metadata that can weaken source binding",
    (metadata) => {
      const workflow = base
        .replace("bun-version: 1.4.0", "bun-version-file: package.json")
        .replace(
          `      - uses: actions/checkout@${"2".repeat(40)}\n`,
          `      - uses: actions/checkout@${"2".repeat(40)}\n${metadata}`,
        );
      expect(() =>
        validateReleaseWorkflow(workflow, ref, () =>
          JSON.stringify({ packageManager: "bun@1.4.0" }),
        ),
      ).toThrow();
    },
  );

  test("rejects a checkout after package.json selects Bun", () => {
    const workflow = base
      .replace("bun-version: 1.4.0", "bun-version-file: package.json")
      .replace(
        `      - uses: actions/setup-node@${"3".repeat(40)}\n`,
        `      - uses: actions/checkout@${"2".repeat(40)}\n      - uses: actions/setup-node@${"3".repeat(40)}\n`,
      );
    expect(() =>
      validateReleaseWorkflow(workflow, ref, () =>
        JSON.stringify({ packageManager: "bun@1.4.0" }),
      ),
    ).toThrow();
  });

  test.each([
    base.replace(
      `      - uses: actions/setup-node@${"3".repeat(40)}\n`,
      `      - run: node scripts/export-proxy.mjs\n      - uses: actions/setup-node@${"3".repeat(40)}\n`,
    ),
    base
      .replace(
        `      - uses: oven-sh/setup-bun@${"4".repeat(40)}\n        with:\n          bun-version: 1.4.0\n`,
        "",
      )
      .replace(
        `      - uses: actions/setup-node@${"3".repeat(40)}\n`,
        `      - run: node scripts/export-proxy.mjs\n      - uses: actions/setup-node@${"3".repeat(40)}\n`,
      ),
  ])("rejects a mutable step before runtime setup", (workflow) => {
    expect(() => validateReleaseWorkflow(workflow, ref)).toThrow();
  });

  test("rejects Node.js setup before Bun setup", () => {
    const bun = `      - uses: oven-sh/setup-bun@${"4".repeat(40)}\n        with:\n          bun-version: 1.4.0\n`;
    const node = `      - uses: actions/setup-node@${"3".repeat(40)}\n        with:\n          node-version: 22.21.1\n`;
    expect(() =>
      validateReleaseWorkflow(base.replace(`${bun}${node}`, `${node}${bun}`), ref),
    ).toThrow();
  });

  test.each([
    [`actions/setup-node@${"3".repeat(40)}`, "        if: false\n"],
    [`actions/setup-node@${"3".repeat(40)}`, "        continue-on-error: true\n"],
    [`actions/setup-node@${"3".repeat(40)}`, "        env:\n          INPUT_NODE-VERSION: latest\n"],
    [`oven-sh/setup-bun@${"4".repeat(40)}`, "        if: false\n"],
    [`oven-sh/setup-bun@${"4".repeat(40)}`, "        continue-on-error: true\n"],
    [`oven-sh/setup-bun@${"4".repeat(40)}`, "        env:\n          INPUT_BUN-VERSION: latest\n"],
  ])("rejects conditional or error-tolerant runtime setup %s", (action, metadata) => {
    const workflow = base.replace(
      `      - uses: ${action}\n`,
      `      - uses: ${action}\n${metadata}`,
    );
    expect(() => validateReleaseWorkflow(workflow, ref)).toThrow();
  });

  test("accepts only the canonical npm registry setup", () => {
    const workflow = base.replace(
      "          node-version: 22.21.1",
      "          node-version: 22.21.1\n          registry-url: https://registry.npmjs.org",
    );
    expect(() => validateReleaseWorkflow(workflow, ref)).not.toThrow();
  });

  test("accepts a non-network Cargo job environment", () => {
    const workflow = base.replace(
      "    runs-on: ubuntu-latest\n    steps:",
      "    runs-on: ubuntu-latest\n    env:\n      CARGO_INCREMENTAL: 0\n    steps:",
    );
    expect(() => validateReleaseWorkflow(workflow, ref)).not.toThrow();
  });

  test.each([
    "    env:\n      HTTPS_PROXY: https://untrusted.example\n",
    "    env:\n      NODE_EXTRA_CA_CERTS: untrusted.pem\n",
    "    container: untrusted/runtime-proxy:latest\n",
    "    services:\n      mutator:\n        image: untrusted/workspace-mutator:latest\n",
    "    continue-on-error: true\n",
  ])("rejects inherited runtime source overrides", (jobMetadata) => {
    const workflow = base.replace(
      "    runs-on: ubuntu-latest\n    steps:",
      `    runs-on: ubuntu-latest\n${jobMetadata}    steps:`,
    );
    expect(() => validateReleaseWorkflow(workflow, ref)).toThrow();
  });

  test("accepts approved GitHub-hosted runtime matrices", () => {
    const workflow = base.replace(
      "    runs-on: ubuntu-latest\n    steps:",
      "    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-15, windows-latest]\n    steps:",
    );
    expect(() => validateReleaseWorkflow(workflow, ref)).not.toThrow();
  });

  test("accepts approved GitHub-hosted include matrices", () => {
    const workflow = base.replace(
      "    runs-on: ubuntu-latest\n    steps:",
      "    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n          - runner: ubuntu-24.04-arm\n          - runner: macos-15-intel\n          - runner: windows-2025\n    steps:",
    );
    expect(() => validateReleaseWorkflow(workflow, ref)).not.toThrow();
  });

  test.each([
    "    runs-on: self-hosted\n",
    "    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, self-hosted]\n",
    "    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n          - runner: ubuntu-24.04\n          - runner: self-hosted\n",
    "    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        include:\n          - os: self-hosted\n",
    "    runs-on: ${{ matrix.settings.os }}\n    strategy:\n      matrix:\n        settings:\n          - os: ubuntu-latest\n        include:\n          - settings:\n              os: self-hosted\n",
  ])("rejects non-hosted runtime runners", (runner) => {
    const workflow = base.replace("    runs-on: ubuntu-latest\n", runner);
    expect(() => validateReleaseWorkflow(workflow, ref)).toThrow();
  });

  test.each([
    [
      "node-version: 22.21.1",
      "node-version: 22.21.1\n          mirror: https://untrusted.example",
    ],
    [
      "node-version: 22.21.1",
      "node-version: 22.21.1\n          registry-url: https://untrusted.example",
    ],
    [
      "bun-version: 1.4.0",
      "bun-version: 1.4.0\n          bun-download-url: https://untrusted.example/bun",
    ],
  ])("rejects runtime source override inputs", (expected, replacement) => {
    expect(() => validateReleaseWorkflow(base.replace(expected, replacement), ref)).toThrow();
  });

  test.each(["always()", "failure()", "!cancelled()", "success()", "!success()"])(
    "rejects failure-bypassing condition %s",
    (condition) => {
      const workflow = base.replace(
        "      - run: npm pack",
        `      - if: >-\n          ${condition}\n        run: npm pack`,
      );
      expect(() => validateReleaseWorkflow(workflow, ref)).toThrow();
    },
  );

  test.each(["inputs.mode == 'success()'", "inputs.mode == \"always()\""])(
    "accepts quoted status-like text in condition %s",
    (condition) => {
      const workflow = base.replace(
        "      - run: npm pack",
        `      - if: >-\n          ${condition}\n        run: npm pack`,
      );
      expect(() => validateReleaseWorkflow(workflow, ref)).not.toThrow();
    },
  );

  test("rejects a real status check after quoted status-like text", () => {
    const workflow = base.replace(
      "      - run: npm pack",
      "      - if: >-\n          inputs.mode == 'success()' || !success()\n        run: npm pack",
    );
    expect(() => validateReleaseWorkflow(workflow, ref)).toThrow();
  });

  test("rejects continue-on-error anywhere in the release graph", () => {
    const workflow = base.replace(
      "      - run: npm pack",
      "      - continue-on-error: true\n        run: npm pack",
    );
    expect(() => validateReleaseWorkflow(workflow, ref)).toThrow();
  });

  test("rejects symlinked Bun manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "release-policy-"));
    const external = join(tmpdir(), `release-policy-external-${process.pid}.json`);
    writeFileSync(external, JSON.stringify({ packageManager: "bun@1.4.0" }));
    symlinkSync(external, join(root, "package.json"));
    try {
      expect(() => readRepositoryFileWithin("package.json", root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { force: true });
    }
  });

  test("accepts the shared independently versioned npm publisher", () => {
    const workflow = base.replace(
      /  finalize:[\s\S]*$/,
      `  release:\n    if: github.ref == 'refs/heads/main' && (true)\n    uses: stella/.github/.github/workflows/npm-independent-release.yml@${ref}\n    with:\n      package-files: package.json\n    permissions:\n      actions: read\n      contents: write\n      id-token: write\n`,
    );
    expect(() => validateReleaseWorkflow(workflow, ref)).not.toThrow();
  });

  test("accepts exact crate publishing and local artifact attestation contracts", () => {
    const workflow = `name: Release
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  attest:
    if: github.ref == 'refs/heads/main' && (true)
    runs-on: ubuntu-latest
    permissions:
      contents: read
      attestations: write
      id-token: write
    steps:
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          name: release-artifacts
          path: release-artifacts
      - uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6
        with:
          subject-path: release-artifacts/*.tgz
  publish-crate:
    if: github.ref == 'refs/heads/main' && (true)
    uses: stella/.github/.github/workflows/crates-io-publish.yml@${ref}
    with:
      crate-name: example-core
      manifest-path: crates/core/Cargo.toml
    permissions:
      contents: read
      attestations: write
      id-token: write
`;
    expect(() => validateReleaseWorkflow(workflow, ref)).not.toThrow();
    expect(() =>
      validateReleaseWorkflow(
        workflow.replace(
          "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
          `actions/attest@${"4".repeat(40)}`,
        ),
        ref,
      ),
    ).toThrow();
    expect(() =>
      validateReleaseWorkflow(
        workflow.replace(
          "          subject-path: release-artifacts/*.tgz",
          "          subject-path: ${{ needs.pack.outputs.tarball }}",
        ),
        ref,
      ),
    ).toThrow();
    expect(() =>
      validateReleaseWorkflow(
        workflow.replace(
          "          subject-path: release-artifacts/*.tgz",
          "          subject-path: |\n            release-artifacts/*.tgz\n            /etc/hosts",
        ),
        ref,
      ),
    ).toThrow();
    expect(() =>
      validateReleaseWorkflow(
        workflow.replace(
          "      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
          "      - uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6\n        with:\n          subject-path: release-artifacts/*.tgz\n      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        ),
        ref,
      ),
    ).toThrow();
    expect(() =>
      validateReleaseWorkflow(
        workflow.replace(
          "          path: release-artifacts",
          "          path: release-artifacts\n          run-id: 123",
        ),
        ref,
      ),
    ).toThrow();
    expect(() =>
      validateReleaseWorkflow(
        workflow.replace(
          "      manifest-path: crates/core/Cargo.toml",
          "      manifest-path: ../Cargo.toml",
        ),
        ref,
      ),
    ).toThrow();
  });

  test.each([
    ["workflow OIDC", base.replace("contents: read\njobs:", "contents: read\n  id-token: write\njobs:")],
    ["public comment trigger", base.replace("  workflow_dispatch:", "  workflow_dispatch:\n  issue_comment:")],
    ["release push without paths", base.replace("  workflow_dispatch:\n", "  push:\n    branches: [main]\n    paths: []\n  workflow_dispatch:\n")],
    ["release tag trigger", base.replace("  workflow_dispatch:\n", "  push:\n    branches: [main]\n    paths: [VERSION]\n    tags: ['v*']\n  workflow_dispatch:\n")],
    ["workflow environment", base.replace("permissions:", "env:\n  BASH_ENV: artifact/payload\npermissions:")],
    ["workflow defaults", base.replace("permissions:", "defaults:\n  run:\n    shell: ./payload\npermissions:")],
    ["mutable action", base.replace("actions/checkout@" + "2".repeat(40), "actions/checkout@main")],
    ["floating Node.js runtime", base.replace("node-version: 22.21.1", "node-version: 22")],
    ["mixed-case floating Node.js runtime", base.replace("actions/setup-node@", "ACTIONS/SETUP-NODE@").replace("node-version: 22.21.1", "node-version: 22")],
    ["missing Node.js runtime", base.replace("        with:\n          node-version: 22.21.1\n", "")],
    ["floating Bun runtime", base.replace("bun-version: 1.4.0", "bun-version: latest")],
    ["mixed-case floating Bun runtime", base.replace("oven-sh/setup-bun@", "OVEN-SH/SETUP-BUN@").replace("bun-version: 1.4.0", "bun-version: latest")],
    ["missing Bun runtime", base.replace("        with:\n          bun-version: 1.4.0\n", "")],
    ["dual Bun version sources", base.replace("bun-version: 1.4.0", "bun-version: 1.4.0\n          bun-version-file: package.json")],
    ["publisher command", base.replace("    steps:\n      - uses: stella/.github/.github/actions/pypi", "    steps:\n      - run: npm install\n      - uses: stella/.github/.github/actions/pypi")],
    ["publisher ref drift", base.replaceAll(ref, "3".repeat(40))],
    ["publisher without main guard", base.replace("    if: github.ref == 'refs/heads/main' && (true)\n    permissions:\n      id-token: write", "    if: true\n    permissions:\n      id-token: write")],
    ["publisher guard bypass", base.replace("github.ref == 'refs/heads/main' && (true)", "github.ref == 'refs/heads/main' && (true) || true")],
    ["conditional PyPI step", base.replace("      - uses: stella/.github/.github/actions/pypi", "      - if: false\n        uses: stella/.github/.github/actions/pypi")],
    ["unexpected PyPI input", base.replace("          wheel-contract:", "          attacker-input: value\n          wheel-contract:")],
    ["empty wheel contract", base.replace("'{\"python-wheel-linux\":[\"manylinux_2_17_x86_64\"]}'", "'{}'")],
    ["finalizer package path escape", base.replace("package-files: package.json", "package-files: ../package.json")],
    ["embedded changelog mutation", base.replace("      package-files: package.json", "      package-files: package.json\n      update-changelog: false")],
    ["changelog credentials", base.replace("      RELEASE_APP_ID: \${{ secrets.RELEASE_APP_ID }}", "      CHANGELOG_APP_ID: \${{ secrets.CHANGELOG_APP_ID }}\n      CHANGELOG_APP_PRIVATE_KEY: \${{ secrets.CHANGELOG_APP_PRIVATE_KEY }}\n      RELEASE_APP_ID: \${{ secrets.RELEASE_APP_ID }}")],
    ["unpaired release secret", base.replace("      RELEASE_APP_PRIVATE_KEY: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}\n", "")],
    ["secret inheritance", base.replace("    secrets:\n      RELEASE_APP_ID: \${{ secrets.RELEASE_APP_ID }}", "    secrets: inherit")],
    ["unexpected secret", base.replace("RELEASE_APP_ID }}", "NPM_TOKEN }}")],
    ["approved secret in a build", base.replace("      - run: npm pack", "      - run: npm pack\n        env:\n          TOKEN: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}")],
    ["approved secret in an arbitrary reusable job", base.replace(/  build:[\s\S]*?(?=  publish-pypi:)/, "  build:\n    uses: owner/repository/.github/workflows/receive-secret.yml@" + "2".repeat(40) + "\n    secrets:\n      RELEASE_APP_PRIVATE_KEY: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}\n")],
    ["whole secrets context", base.replace("      - run: npm pack", "      - run: npm pack\n        env:\n          ALL_SECRETS: \${{ toJSON(secrets) }}")],
    ["extra write grant", base.replace("      id-token: write\n    steps:", "      id-token: write\n      packages: write\n    steps:")],
    ["new write permission", base.replace("    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout", "    runs-on: ubuntu-latest\n    permissions:\n      artifact-metadata: write\n    steps:\n      - uses: actions/checkout")],
    ["privileged container", base.replace("    permissions:\n      id-token: write", "    container: attacker/image\n    permissions:\n      id-token: write")],
    ["privileged job environment", base.replace("    permissions:\n      id-token: write", "    env:\n      ATTACK: yes\n    permissions:\n      id-token: write")],
  ])("rejects %s", (_name, workflow) => {
    expect(() => validateReleaseWorkflow(workflow, ref)).toThrow();
  });
});
