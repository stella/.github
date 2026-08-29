from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import sys

MODULE_PATH = Path(__file__).with_name("verify_registry.py")
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("verify_registry", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RegistryVerificationTest(unittest.TestCase):
    def test_normalizes_stella_prereleases_for_pypi(self) -> None:
        self.assertEqual(MODULE.pep440_version("1.2.3-alpha.4"), "1.2.3a4")
        self.assertEqual(MODULE.pep440_version("1.2.3-beta.4"), "1.2.3b4")
        self.assertEqual(MODULE.pep440_version("1.2.3-rc.4"), "1.2.3rc4")

    def test_accepts_exact_registry_bytes(self) -> None:
        self.assertTrue(
            MODULE.compare_registry_files(
                {"one.whl": "a" * 64}, {"one.whl": "a" * 64}, allow_missing=False
            )
        )

    def test_allows_missing_files_only_during_preflight(self) -> None:
        self.assertTrue(
            MODULE.compare_registry_files({"one.whl": "a" * 64}, {}, allow_missing=True)
        )
        self.assertFalse(
            MODULE.compare_registry_files({"one.whl": "a" * 64}, {}, allow_missing=False)
        )

    def test_rejects_an_existing_filename_with_different_bytes(self) -> None:
        with self.assertRaisesRegex(SystemExit, "prepared artifact"):
            MODULE.compare_registry_files(
                {"one.whl": "a" * 64}, {"one.whl": "b" * 64}, allow_missing=True
            )


if __name__ == "__main__":
    unittest.main()
