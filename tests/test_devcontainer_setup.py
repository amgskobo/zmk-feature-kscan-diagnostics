"""Exercise repository trust during initialization without fetching dependencies."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class DevcontainerSetup(unittest.TestCase):
    def test_git_backed_tools_can_read_a_mounted_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "module"
            repository.mkdir()
            subprocess.run(["git", "init", "--quiet", repository], check=True)
            config = repository / ".devcontainer"
            config.mkdir()
            shutil.copy2(
                Path(__file__).resolve().parents[1] / ".devcontainer/init.sh",
                config / "init.sh",
            )

            commands = root / "commands"
            commands.mkdir()

            def command(name, body):
                path = commands / name
                path.write_text("#!/bin/sh\nset -eu\n" + body + "\n")
                path.chmod(0o755)

            # Network preparation is outside this test. The hook installer still
            # requires real Git access, as pre-commit does during initialization.
            command("python3", "exit 0")
            command("west", 'if [ "$1" = topdir ]; then exit 1; fi')
            command("npm", "exit 0")
            command(
                "pre-commit",
                "git rev-parse --show-toplevel > /dev/null\n"
                'printf \'%s\\n\' "$*" >> "$INIT_TEST_COMMANDS"',
            )
            environment = dict(
                os.environ,
                PATH=str(commands) + os.pathsep + os.environ["PATH"],
                GIT_CONFIG_GLOBAL=str(root / "gitconfig"),
                GIT_CONFIG_SYSTEM=os.devnull,
                GIT_CONFIG_NOSYSTEM="1",
                GIT_TEST_ASSUME_DIFFERENT_OWNER="1",
                LC_ALL="C",
                INIT_TEST_COMMANDS=str(root / "installed"),
            )
            denied = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=repository,
                env=environment,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(denied.returncode, 0)
            self.assertIn("dubious ownership", denied.stderr)

            initialized = subprocess.run(
                ["bash", config / "init.sh"],
                cwd=repository,
                env=environment,
                capture_output=True,
                text=True,
            )
            self.assertEqual(
                initialized.returncode, 0, initialized.stdout + initialized.stderr
            )
            self.assertEqual(
                (root / "installed").read_text().splitlines(),
                ["install-hooks", "install"],
            )
