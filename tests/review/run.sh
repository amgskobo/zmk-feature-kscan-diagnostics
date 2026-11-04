#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
root="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
if [[ -n ${KSCAN_REVIEW_OUTPUT:-} && ( -e "$KSCAN_REVIEW_OUTPUT" || -L "$KSCAN_REVIEW_OUTPUT" ) ]]; then
    echo 'Use a fresh KSCAN_REVIEW_OUTPUT directory' >&2; exit 2
fi
export ZEPHYR_BASE="${ZEPHYR_BASE:-$(west list zephyr -f '{abspath}')}"
zmk_root="${ZMK_ROOT:-$(west list zmk -f '{abspath}')}"
nanopb_root="${NANOPB_ROOT:-$(west list nanopb -f '{abspath}')}"
owner="${KSCAN_REVIEW_SOURCE_ROOT:-$root}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT HUP INT TERM
out="${KSCAN_REVIEW_OUTPUT:-$(mktemp -d -t kscan-review-evidence-XXXXXX)}"
mkdir -p "$out" "$work/generated"
cp -a "$nanopb_root/generator" "$work/generator"
python3 "$work/generator/nanopb_generator.py" -I "$root/proto" -D "$work/generated" \
    "$root/proto/cormoran/kscan_diagnostics/kscan_diagnostics.proto"
python3 "$work/generator/nanopb_generator.py" -I "$root/tests/review" -D "$work/generated" \
    "$root/tests/review/envelope.proto"
failed=0
for sanitizer in normal asan-ubsan; do
    for variant in central central-unsecured peripheral fallback scan-only; do
        args=()
        overlay=explicit
        case "$variant" in
            central) args+=(-DREVIEW_CENTRAL=ON);;
            central-unsecured) args+=(-DREVIEW_CENTRAL=ON -DREVIEW_UNSECURED=ON);;
            fallback) overlay=fallback; args+=(-DREVIEW_FALLBACK=ON);;
            scan-only) overlay=scan-only; args+=(-DREVIEW_SCAN_ONLY=ON);;
        esac
        if [ "$sanitizer" = asan-ubsan ]; then
            args+=(-DCONFIG_ASAN=y -DCONFIG_ASAN_RECOVER=n -DCONFIG_UBSAN=y)
        fi
        name="$variant-$sanitizer"
        mkdir -p "$out/$name"
        if ! west build -p=always -b native_sim/native/64 -s "$root/tests/review" -d "$work/$name" -- \
            -DOWNER_ROOT="$owner" -DZMK_ROOT="$zmk_root" -DNANOPB_ROOT="$nanopb_root" \
            -DGENERATED_ROOT="$work/generated" -DDTC_OVERLAY_FILE="$root/tests/review/$overlay.overlay" \
            -DWEST=OFF -DZEPHYR_MODULES= -DZephyr_DIR="$ZEPHYR_BASE/share/zephyr-package/cmake" \
            "${args[@]}" > "$out/$name/build.log" 2>&1; then
            cat "$out/$name/build.log" >&2; exit 2
        fi
        cp "$work/$name/CMakeCache.txt" "$out/$name/"
        cp "$work/$name/zephyr/.config" "$out/$name/config"
        cp "$work/$name/zephyr/zephyr.elf" "$work/$name/zephyr/zephyr.exe" "$out/$name/"
        for run in 1 2 3; do
            mkdir -p "$out/$name/run-$run"
            status=0
            (cd "$out/$name/run-$run" && ASAN_OPTIONS=halt_on_error=1:detect_leaks=0 \
                UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
                timeout 20 "$work/$name/zephyr/zephyr.exe") > "$out/$name/run-$run.log" 2>&1 || status=$?
            cat "$out/$name/run-$run.log"
            if ! grep -Eq '^PASS kscan review boundaries complete' "$out/$name/run-$run.log"; then status=1; fi
            if grep -Eq 'FAIL |AddressSanitizer|runtime error:|ASSERTION FAIL' "$out/$name/run-$run.log"; then status=1; fi
            printf '%s %s %s\n' "$name" "$run" "$status" >> "$out/status.tsv"
            [ "$status" = 0 ] || failed=1
        done
    done
done
echo 'Completed kscan review variants=10 repeats=3'
exit "$failed"
