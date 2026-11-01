from __future__ import annotations

import platform
import os
import json
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from dataclasses import dataclass

THIS_DIR = Path(__file__).parent.resolve()
TEST_BUILD_DIR_NAME = "tests-zmk-feature-kscan-diagnostics"


def run_west(
    args: list[str], evidence: Path | None = None
) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment.setdefault("CMAKE_BUILD_PARALLEL_LEVEL", "2")
    if args and args[0] == "zmk-build":
        args = [*args, "--parallelism", "1"]
    command = ["west", *args]
    start = time.monotonic_ns()
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=THIS_DIR,
        env=environment,
    )
    result.stderr = ""
    if evidence:
        (evidence / (args[0] + ".log")).write_text(result.stdout)
        (evidence / (args[0] + ".json")).write_text(
            json.dumps(
                dict(
                    argv=command,
                    exit=result.returncode,
                    elapsed_ns=time.monotonic_ns() - start,
                    compiler_jobs=environment["CMAKE_BUILD_PARALLEL_LEVEL"],
                    stderr="merged into ordered stdout",
                ),
                indent=2,
            )
            + "\n"
        )
    return result


def fresh_output() -> Path:
    requested = os.environ.get("OWNER_TEST_OUTPUT")
    if not requested:
        return Path(tempfile.mkdtemp(prefix="kscan-owner-"))
    output = Path(requested).resolve()
    if output.is_relative_to(THIS_DIR):
        raise ValueError("Owner output must be outside the source checkout")
    output.mkdir(parents=True, exist_ok=False)
    return output


@dataclass
class NotFound:
    text: str


@dataclass
class ConfigAndDeviceTree:
    # Expected rows in .config
    config: list[str | NotFound]
    # Expected rows in devicetree_generated.h
    device: list[str | NotFound]


class WestCommandsTests(unittest.TestCase):
    WEST_TOPDIR: Path
    BUILD_DIR: Path

    @classmethod
    def setUpClass(cls):
        result = run_west(["topdir"])
        if result.returncode or not result.stdout.strip():
            raise RuntimeError(result.stdout + result.stderr)
        cls.WEST_TOPDIR = Path(result.stdout.strip())
        cls.BUILD_DIR = fresh_output()
        print(f"Owner test output: {cls.BUILD_DIR}", flush=True)

    @unittest.skipUnless(
        platform.system() == "Linux", "zmk-test is only supported on Linux"
    )
    def test_zmk_test(self):
        test_build_dir = self.BUILD_DIR / TEST_BUILD_DIR_NAME
        shutil.rmtree(test_build_dir, ignore_errors=True)

        result = run_west(
            ["zmk-test", "tests", "-m", ".", "-d", str(test_build_dir)],
            self.BUILD_DIR,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS: test", result.stdout, result.stdout + result.stderr)
        self.assertIn("PASS: studio", result.stdout, result.stdout + result.stderr)
        self.assertIn("PASS: mock-timing", result.stdout, result.stdout + result.stderr)
        self.assertNotIn("FAILED: ", result.stdout, result.stdout + result.stderr)

    def test_zmk_build(self):
        self._test_zmk_build(
            {
                "kscan_diagnostics_board_feature_disabled": ConfigAndDeviceTree(
                    config=[
                        'CONFIG_ZMK_KEYBOARD_NAME="Module Test"',
                        "CONFIG_ZMK_USB=y",
                        "CONFIG_ZMK_BLE=y",
                        "# CONFIG_ZMK_KSCAN_DIAGNOSTICS is not set",
                    ],
                    device=[
                        "DT_COMPAT_HAS_OKAY_zmk_keymap",
                    ],
                ),
                "kscan_diagnostics_board_with_rpc": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_ZMK_STUDIO=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC=y",
                    ],
                    device=[],
                ),
                "kscan_diagnostics_board_without_rpc": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS=y",
                        "# CONFIG_ZMK_STUDIO is not set",
                        NotFound("CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC"),
                    ],
                    device=[],
                ),
                "custom_settings_board": ConfigAndDeviceTree(
                    config=[
                        # Verify that zmk-feature-custom-settings is present and enabled
                        "zmk-feature-custom-settings",
                        "CONFIG_ZMK_STUDIO=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC=y",
                        "CONFIG_ZMK_CUSTOM_SETTINGS=y",
                        "CONFIG_ZMK_CUSTOM_SETTINGS_STUDIO_RPC=y",
                        "CONFIG_ZMK_STUDIO_RPC_RX_BUF_SIZE=128",
                        "CONFIG_ZMK_LOW_PRIORITY_THREAD_STACK_SIZE=2048",
                    ],
                    device=[],
                ),
                "kscan_diagnostics_board_matrix": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_ZMK_STUDIO=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC=y",
                        "CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE=256",
                    ],
                    device=[
                        "DT_COMPAT_HAS_OKAY_zmk_kscan_gpio_matrix",
                        NotFound("DT_COMPAT_HAS_OKAY_zmk_kscan_gpio_direct"),
                    ],
                ),
                "kscan_diagnostics_board_composite": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_ZMK_STUDIO=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC=y",
                        "CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE=256",
                    ],
                    device=[
                        "DT_COMPAT_HAS_OKAY_zmk_kscan_composite",
                        "DT_COMPAT_HAS_OKAY_zmk_kscan_gpio_direct",
                        "DT_COMPAT_HAS_OKAY_zmk_kscan_gpio_matrix",
                    ],
                ),
                "kscan_diagnostics_board_charlieplex_demux": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_ZMK_STUDIO=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC=y",
                        "CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE=256",
                    ],
                    device=[
                        "DT_COMPAT_HAS_OKAY_zmk_kscan_gpio_charlieplex",
                        "DT_COMPAT_HAS_OKAY_zmk_kscan_gpio_demux",
                    ],
                ),
                # Split event-relay compile coverage: the central role builds
                # the QueryPeripheral relay + PeripheralEvent notification path,
                # the peripheral role builds the query-answering path. Both pull
                # NANOPB in without/with ZMK_STUDIO and select ZMK_SPLIT_RELAY_EVENT.
                "kscan_diagnostics_board_split_central": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_ZMK_STUDIO=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS_SPLIT=y",
                        "CONFIG_ZMK_SPLIT_ROLE_CENTRAL=y",
                        "CONFIG_ZMK_SPLIT_RELAY_EVENT=y",
                        "CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=256",
                        "CONFIG_NANOPB=y",
                    ],
                    device=[],
                ),
                "kscan_diagnostics_board_split_peripheral": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS_SPLIT=y",
                        "# CONFIG_ZMK_STUDIO is not set",
                        "# CONFIG_ZMK_SPLIT_ROLE_CENTRAL is not set",
                        "CONFIG_ZMK_SPLIT_RELAY_EVENT=y",
                        "CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=256",
                        "CONFIG_NANOPB=y",
                        NotFound("CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC"),
                    ],
                    device=[],
                ),
                "kscan_diagnostics_board_hw_mock": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_ZMK_STUDIO=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS=y",
                        "CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC=y",
                        "# CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC_TEST is not set",
                        "# CONFIG_ZMK_KSCAN_DIAGNOSTICS_MOCK_TIMING_TEST is not set",
                    ],
                    device=["DT_COMPAT_HAS_OKAY_zmk_kscan_mock"],
                ),
            }
        )

    def _test_zmk_build(
        self, artifacts_and_expected_build_params: dict[str, ConfigAndDeviceTree]
    ):

        for artifact in artifacts_and_expected_build_params.keys():
            shutil.rmtree(self.BUILD_DIR / artifact, ignore_errors=True)

        result = run_west(
            ["zmk-build", "tests/zmk-config", "-q", "-d", str(self.BUILD_DIR)],
            self.BUILD_DIR,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        for artifact, entries in artifacts_and_expected_build_params.items():
            artifact_dir = self.BUILD_DIR / artifact / "zephyr"
            config_path = artifact_dir / ".config"
            device_tree_path = (
                artifact_dir
                / "include"
                / "generated"
                / "zephyr"
                / "devicetree_generated.h"
            )
            self._test_strings_in_file(
                config_path, entries.config, f"{artifact} config"
            )
            if entries.device:
                self._test_strings_in_file(
                    device_tree_path, entries.device, f"{artifact} device tree"
                )
            self.assertTrue(
                (artifact_dir / "zmk.uf2").exists(),
                f"{artifact} zmk.uf2 is missing in {artifact_dir}",
            )

    def _test_strings_in_file(
        self, file_path: Path, expected_strings: list[str | NotFound], hint: str
    ):
        self.assertTrue(file_path.exists(), f"{hint}: {file_path} is missing")
        file_text = file_path.read_text()

        for expected in expected_strings:
            if isinstance(expected, NotFound):
                if expected.text in file_text:
                    self.fail(
                        f"{hint}: {expected.text} found in {file_path}, but it should not be present"
                    )
            else:
                if expected not in file_text:
                    self.fail(f"{hint}: {expected} not found in {file_path}")


if __name__ == "__main__":
    unittest.main()
