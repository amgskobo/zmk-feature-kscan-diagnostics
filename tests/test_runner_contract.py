import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import test as owner


class OutputContract(unittest.TestCase):
    def test_existing_output_preserves_prior_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "retained"
            output.mkdir()
            sentinel = output / "sentinel"
            sentinel.write_text("keep")
            with patch.dict(os.environ, {"OWNER_TEST_OUTPUT": str(output)}):
                with self.assertRaises(FileExistsError):
                    owner.fresh_output()
            self.assertEqual(sentinel.read_text(), "keep")

    def test_output_cannot_be_inside_owned_source(self):
        root = Path(__file__).resolve().parents[1]
        with patch.dict(os.environ, {"OWNER_TEST_OUTPUT": str(root / "test-output")}):
            with self.assertRaises(ValueError):
                owner.fresh_output()

    def test_failed_workspace_does_not_create_requested_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "new"
            result = subprocess.CompletedProcess(["west", "topdir"], 1, "", "failure")
            with patch("test.run_west", return_value=result):
                with patch.dict(os.environ, {"OWNER_TEST_OUTPUT": str(output)}):
                    with self.assertRaises(RuntimeError):
                        owner.WestCommandsTests.setUpClass()
            self.assertFalse(output.exists())
