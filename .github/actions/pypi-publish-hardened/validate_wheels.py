from __future__ import annotations

import json
import os
import shutil
import stat
import sys
import zipfile
from email.parser import Parser
from pathlib import Path

from release_version import pep440_version

MAX_METADATA_BYTES = 1024 * 1024


def fail(message: str) -> None:
    raise SystemExit(message)


def regular_file(path: Path) -> bool:
    mode = path.lstat().st_mode
    return stat.S_ISREG(mode) and not path.is_symlink()


def validate_wheel(
    wheel: Path,
    *,
    expected_filename: str,
    expected_project: str,
    expected_version: str,
    expected_tags: set[str],
) -> None:
    if wheel.name != expected_filename:
        fail(f"expected {expected_filename}, found {wheel.name}")
    if not regular_file(wheel):
        fail(f"wheel must be a regular, non-symlink file: {wheel}")

    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        dist_info = f"{expected_filename.split('-cp311-abi3-', 1)[0]}.dist-info"
        metadata_name = f"{dist_info}/METADATA"
        wheel_name = f"{dist_info}/WHEEL"
        if names.count(metadata_name) != 1 or names.count(wheel_name) != 1:
            fail(
                f"{wheel.name} must contain exactly one {metadata_name} and one {wheel_name}"
            )
        if any(
            name.endswith(".dist-info/METADATA") and name != metadata_name
            or name.endswith(".dist-info/WHEEL") and name != wheel_name
            for name in names
        ):
            fail(f"{wheel.name} contains metadata outside {dist_info}")
        metadata_info = archive.getinfo(metadata_name)
        wheel_info = archive.getinfo(wheel_name)
        if metadata_info.file_size > MAX_METADATA_BYTES or wheel_info.file_size > MAX_METADATA_BYTES:
            fail(f"metadata in {wheel.name} exceeds {MAX_METADATA_BYTES} bytes")
        metadata = Parser().parsestr(archive.read(metadata_info).decode("utf8"))
        wheel_metadata = Parser().parsestr(archive.read(wheel_info).decode("utf8"))

    if metadata.get("Name") != expected_project:
        fail(f"{wheel.name} has project {metadata.get('Name')!r}; expected {expected_project!r}")
    if metadata.get("Version") != expected_version:
        fail(f"{wheel.name} has version {metadata.get('Version')!r}; expected {expected_version!r}")
    actual_tag_list = wheel_metadata.get_all("Tag", [])
    actual_tags = set(actual_tag_list)
    if len(actual_tag_list) != len(expected_tags) or actual_tags != expected_tags:
        fail(
            f"{wheel.name} has tags {sorted(actual_tag_list)}; "
            f"expected {sorted(expected_tags)}"
        )


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: validate_wheels.py <artifact-root> <output-directory>")
    artifact_root = Path(sys.argv[1])
    output = Path(sys.argv[2])
    project = os.environ["PROJECT_NAME"]
    distribution = os.environ["DISTRIBUTION_NAME"]
    try:
        version = pep440_version(os.environ["EXPECTED_VERSION"])
    except ValueError as error:
        fail(str(error))
    contract = json.loads(os.environ["WHEEL_CONTRACT"])
    if not isinstance(contract, dict) or not contract:
        fail("wheel-contract must be a non-empty JSON object")

    actual_artifacts = {path.name for path in artifact_root.iterdir() if path.is_dir()}
    expected_artifacts = set(contract)
    if actual_artifacts != expected_artifacts:
        fail(
            f"wheel artifacts are {sorted(actual_artifacts)}; expected {sorted(expected_artifacts)}"
        )

    output.mkdir(parents=True, exist_ok=False)
    destination_names: set[str] = set()
    for artifact_name, platform_tags in contract.items():
        if not isinstance(platform_tags, list) or not platform_tags:
            fail(f"{artifact_name} must declare at least one platform tag")
        artifact = artifact_root / artifact_name
        if artifact.is_symlink() or not stat.S_ISDIR(artifact.lstat().st_mode):
            fail(f"artifact must be a real directory: {artifact_name}")
        entries = list(artifact.iterdir())
        wheels = [path for path in entries if path.suffix == ".whl"]
        if len(entries) != 1 or len(wheels) != 1:
            fail(f"{artifact_name} must contain exactly one wheel and no other entries")
        filename_platforms = ".".join(platform_tags)
        expected_filename = f"{distribution}-{version}-cp311-abi3-{filename_platforms}.whl"
        if expected_filename in destination_names:
            fail(f"multiple artifacts resolve to destination wheel {expected_filename}")
        destination_names.add(expected_filename)
        expected_tags = {f"cp311-abi3-{tag}" for tag in platform_tags}
        validate_wheel(
            wheels[0],
            expected_filename=expected_filename,
            expected_project=project,
            expected_version=version,
            expected_tags=expected_tags,
        )
        shutil.copyfile(wheels[0], output / wheels[0].name)


if __name__ == "__main__":
    main()
