from copy import deepcopy
from pathlib import Path
import unittest
import re
from unittest.mock import patch

import yaml

from tools.verify_review_dependencies import (
    selected_projects,
    selected_test_projects,
    verify_remote,
)


class ReviewDependencyContract(unittest.TestCase):
    def test_core_and_helper_inputs_have_full_pins(self):
        root = Path(__file__).resolve().parents[1]
        data = yaml.safe_load(
            (root / "west/west-dependency/west-test-dependency.yml").read_text()
        )["manifest"]
        projects = data["projects"]
        self.assertEqual(
            {project["name"] for project in projects},
            {"zmk", "zephyr", "zmk-west-commands"},
        )
        for project in projects:
            self.assertRegex(project["revision"], re.compile(r"^[0-9a-f]{40}$"))
        selected_test_projects({"manifest": data})
        changed = deepcopy(data)
        changed["projects"][0]["revision"] = "main"
        with self.assertRaises(ValueError):
            selected_test_projects({"manifest": changed})

    def setUp(self):
        manifest = (
            Path(__file__).resolve().parents[1]
            / "west/west-dependency/west-dependency.yml"
        )
        self.document = yaml.safe_load(manifest.read_text())

    def test_owned_manifest_selects_complete_pinned_forks(self):
        self.assertEqual(len(selected_projects(self.document)), 1)
        missing = deepcopy(self.document)
        missing["manifest"]["projects"].pop()
        with self.assertRaises(ValueError):
            selected_projects(missing)

    def test_rejects_upstream_moving_refs_and_wrong_branches(self):
        for field, value in [
            ("url", "https://github.com/cormoran/zmk-feature-custom-settings"),
            ("revision", "main"),
            ("userdata", {"review-branch": "codex/other-review"}),
        ]:
            with self.subTest(field=field):
                document = deepcopy(self.document)
                document["manifest"]["projects"][0][field] = value
                with self.assertRaises(ValueError):
                    selected_projects(document)

    @patch("tools.verify_review_dependencies.subprocess.check_output")
    def test_checks_the_named_remote_ref(self, read_ref):
        for project in selected_projects(self.document):
            ref = "refs/heads/" + project["userdata"]["review-branch"]
            read_ref.return_value = project["revision"] + "\t" + ref + "\n"
            verify_remote(project)
            self.assertEqual(read_ref.call_args.args[0][-1], ref)
            self.assertEqual(read_ref.call_args.args[0][-2], project["url"])

    @patch("tools.verify_review_dependencies.subprocess.check_output")
    def test_rejects_missing_different_and_unrelated_remote_tips(self, read_ref):
        project = selected_projects(self.document)[0]
        ref = "refs/heads/" + project["userdata"]["review-branch"]
        for response in [
            "",
            "0" * 40 + "\t" + ref,
            project["revision"] + "\trefs/heads/main",
        ]:
            with self.subTest(response=response):
                read_ref.return_value = response
                with self.assertRaises(ValueError):
                    verify_remote(project)
