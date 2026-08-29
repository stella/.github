from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

VALIDATOR = Path(__file__).with_name("validate_wheels.py")
CONTRACT = {
    "python-wheel-linux": ["manylinux_2_17_x86_64", "manylinux2014_x86_64"],
    "python-wheel-macos": ["macosx_11_0_arm64"],
}


def pep440(version: str) -> str:
    return version.replace("-alpha.", "a").replace("-beta.", "b").replace("-rc.", "rc")


class WheelValidatorTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def make_fixture(self, version: str = "1.2.3") -> tuple[Path, Path]:
        artifacts = self.root / "artifacts"
        for artifact, platforms in CONTRACT.items():
            directory = artifacts / artifact
            directory.mkdir(parents=True)
            wheel_version = pep440(version)
            filename = f"example_core-{wheel_version}-cp311-abi3-{'.'.join(platforms)}.whl"
            dist_info = f"example_core-{wheel_version}.dist-info"
            with zipfile.ZipFile(directory / filename, "w") as wheel:
                wheel.writestr(
                    f"{dist_info}/METADATA",
                    f"Metadata-Version: 2.4\nName: example-core\nVersion: {wheel_version}\n",
                )
                wheel.writestr(
                    f"{dist_info}/WHEEL",
                    "Wheel-Version: 1.0\n"
                    + "".join(f"Tag: cp311-abi3-{platform}\n" for platform in platforms),
                )
        return artifacts, self.root / "dist"

    def run_validator(
        self,
        version: str,
        artifacts: Path,
        output: Path,
        contract: dict[str, list[str]] = CONTRACT,
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ | {
            "PROJECT_NAME": "example-core",
            "DISTRIBUTION_NAME": "example_core",
            "EXPECTED_VERSION": version,
            "WHEEL_CONTRACT": json.dumps(contract),
        }
        return subprocess.run(
            ["python3", str(VALIDATOR), str(artifacts), str(output)],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )

    def test_accepts_stable_and_prerelease_exact_wheel_sets(self) -> None:
        for version in ["1.2.3", "1.2.3-alpha.4", "1.2.3-beta.4", "1.2.3-rc.4"]:
            with self.subTest(version=version):
                artifacts, output = self.make_fixture(version)
                result = self.run_validator(version, artifacts, output)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(list(output.glob("*.whl"))), len(CONTRACT))
                for child in list(self.root.iterdir()):
                    if child.is_dir():
                        shutil.rmtree(child)

    def test_rejects_an_extra_artifact(self) -> None:
        artifacts, output = self.make_fixture()
        (artifacts / "python-wheel-extra").mkdir()
        result = self.run_validator("1.2.3", artifacts, output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("wheel artifacts are", result.stderr)

    def test_rejects_a_mutated_wheel_tag(self) -> None:
        artifacts, output = self.make_fixture()
        wheel_path = next((artifacts / "python-wheel-macos").glob("*.whl"))
        replacement = wheel_path.with_name(wheel_path.name.replace("macosx_11_0_arm64", "macosx_12_0_arm64"))
        wheel_path.rename(replacement)
        result = self.run_validator("1.2.3", artifacts, output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected example_core", result.stderr)

    def test_rejects_a_symlinked_wheel(self) -> None:
        artifacts, output = self.make_fixture()
        directory = artifacts / "python-wheel-macos"
        wheel_path = next(directory.glob("*.whl"))
        target = self.root / wheel_path.name
        wheel_path.rename(target)
        wheel_path.symlink_to(target)
        result = self.run_validator("1.2.3", artifacts, output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("regular, non-symlink", result.stderr)

    def test_rejects_duplicate_destination_filenames(self) -> None:
        artifacts, output = self.make_fixture()
        duplicate_contract = {
            artifact: CONTRACT["python-wheel-linux"] for artifact in CONTRACT
        }
        result = self.run_validator("1.2.3", artifacts, output, duplicate_contract)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("multiple artifacts resolve", result.stderr)

    def test_rejects_metadata_from_another_dist_info_directory(self) -> None:
        artifacts, output = self.make_fixture()
        wheel_path = next((artifacts / "python-wheel-macos").glob("*.whl"))
        with zipfile.ZipFile(wheel_path, "a") as wheel:
            wheel.writestr(
                "other-1.2.3.dist-info/METADATA",
                "Metadata-Version: 2.4\nName: example-core\nVersion: 1.2.3\n",
            )
        result = self.run_validator("1.2.3", artifacts, output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("metadata outside", result.stderr)

    def test_rejects_duplicate_wheel_tags(self) -> None:
        artifacts, output = self.make_fixture()
        wheel_path = next((artifacts / "python-wheel-macos").glob("*.whl"))
        replacement = wheel_path.with_suffix(".replacement")
        wheel_metadata = "example_core-1.2.3.dist-info/WHEEL"
        with zipfile.ZipFile(wheel_path) as source, zipfile.ZipFile(
            replacement, "w"
        ) as target:
            for info in source.infolist():
                contents = source.read(info)
                if info.filename == wheel_metadata:
                    contents = (
                        "Wheel-Version: 1.0\n"
                        "Tag: cp311-abi3-macosx_11_0_arm64\n"
                        "Tag: cp311-abi3-macosx_11_0_arm64\n"
                    ).encode()
                target.writestr(info, contents)
        replacement.replace(wheel_path)
        result = self.run_validator("1.2.3", artifacts, output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("has tags", result.stderr)


if __name__ == "__main__":
    unittest.main()
