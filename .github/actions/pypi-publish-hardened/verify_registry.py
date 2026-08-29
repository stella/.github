from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from release_version import pep440_version


def fail(message: str) -> None:
    raise SystemExit(message)


def local_digests(directory: Path) -> dict[str, str]:
    wheels = sorted(directory.glob("*.whl"))
    if not wheels:
        fail(f"no wheels found in {directory}")
    return {wheel.name: hashlib.sha256(wheel.read_bytes()).hexdigest() for wheel in wheels}


def compare_registry_files(
    expected: dict[str, str], registry: dict[str, str], *, allow_missing: bool
) -> bool:
    missing: list[str] = []
    for filename, digest in expected.items():
        published = registry.get(filename)
        if published is None:
            missing.append(filename)
            continue
        if published != digest:
            fail(
                f"PyPI has {filename} with SHA-256 {published}; prepared artifact is {digest}"
            )
    if missing and not allow_missing:
        return False
    return True


def fetch_registry_files(project: str, version: str) -> dict[str, str] | None:
    project_path = urllib.parse.quote(project, safe="")
    version_path = urllib.parse.quote(version, safe="")
    request = urllib.request.Request(
        f"https://pypi.org/pypi/{project_path}/{version_path}/json",
        headers={"User-Agent": "stella-shared-pypi-publisher"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        fail(f"PyPI returned HTTP {error.code} while verifying registry bytes")
    except urllib.error.URLError as error:
        fail(f"PyPI verification request failed: {error.reason}")
    return {
        entry["filename"]: entry["digests"]["sha256"]
        for entry in payload.get("urls", [])
        if isinstance(entry.get("filename"), str)
        and isinstance(entry.get("digests"), dict)
        and isinstance(entry["digests"].get("sha256"), str)
    }


def main() -> None:
    allow_missing = "--allow-missing" in sys.argv[1:]
    directory = Path("dist")
    expected = local_digests(directory)
    project = os.environ["PROJECT_NAME"]
    try:
        version = pep440_version(os.environ["PYPI_VERSION"])
    except ValueError as error:
        fail(str(error))
    attempts = 1 if allow_missing else 12
    for attempt in range(1, attempts + 1):
        registry = fetch_registry_files(project, version)
        if registry is None:
            if allow_missing:
                return
        elif compare_registry_files(expected, registry, allow_missing=allow_missing):
            return
        if attempt < attempts:
            time.sleep(5)
    fail(f"PyPI did not expose every prepared wheel for {project} {version}")


if __name__ == "__main__":
    main()
