from __future__ import annotations

import re

SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$")


def pep440_version(version: str) -> str:
    match = SEMVER.fullmatch(version)
    if match is None:
        raise ValueError(f"invalid Stella release version: {version}")
    major, minor, patch, prerelease, number = match.groups()
    if prerelease is None:
        return f"{major}.{minor}.{patch}"
    prefix = {"alpha": "a", "beta": "b", "rc": "rc"}[prerelease]
    return f"{major}.{minor}.{patch}{prefix}{number}"
