"""Restore one reviewed defect in an isolated container source copy."""

import argparse
from pathlib import Path
import re


FAULTS = {
    "late-lock": (
        "src/split/kscan_diagnostics_relay.c",
        "encoding->allowed = ksd_reply_current(encoding->epoch, encoding->deadline);",
        "encoding->allowed = true;",
    ),
    "inner-length": (
        "src/split/kscan_diagnostics_relay.c",
        "if (query->len > sizeof(query->data)) {",
        "if (false && query->len > sizeof(query->data)) {",
    ),
    "inner-worker": (
        "src/split/kscan_diagnostics_relay.c",
        "if (answer_query.len > sizeof(answer_query.data)) continue;",
        "/* Negative control: trust the queued inner length. */",
    ),
    "map-offset": (
        "src/topology.c",
        "const struct ksd_layout_dt_entry *entry = &ksd_layout_dt_entries[layout_index];",
        "const struct ksd_layout_dt_entry *entry = &ksd_layout_dt_entries[layout_index]; row += entry->row_offset; column += entry->col_offset;",
    ),
    "fallback": (
        "src/topology.c",
        "#elif DT_HAS_CHOSEN(zmk_matrix_transform)",
        "#elif 0",
    ),
    "web-lock": (
        "web/src/useInputStream.ts",
        "session.request++;",
        "return; /* Negative control retains the old live state and ticket. */",
    ),
    "ghost-window": (
        "web/src/TestWizard.tsx",
        "requestedPositions: ghostRun?.requested,",
        "requestedPositions: new Set(positionsUnderTest),",
    ),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fault", choices=[*FAULTS, "wired-size"])
    parser.add_argument("isolated_owner", type=Path)
    args = parser.parse_args()
    owner = Path(__file__).resolve().parents[1]
    isolated = args.isolated_owner.resolve()
    if isolated == owner or isolated.is_relative_to(owner):
        parser.error("Use an isolated container source copy")
    if args.fault == "wired-size":
        # A build rejection is the expected control only for the documented
        # core wire-size boundary; all other controls need executable failures.
        path = isolated / "tests/review/CMakeLists.txt"
        old = "CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=240"
        content = path.read_text()
        if content.count(old) != 1:
            parser.error("Expected one wired capacity definition")
        path.write_text(
            content.replace(old, "CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=256")
        )
    else:
        relative, old, new = FAULTS[args.fault]
        path = isolated / relative
        content = path.read_text()
        if args.fault == "web-lock":
            begin = content.index('type: "core"')
            end = content.index("const lease = session.lease", begin)
            prefix, content, suffix = content[:begin], content[begin:end], content[end:]
        else:
            prefix, suffix = "", ""
        tokens = re.findall(
            r"[A-Za-z_]\w*|\d+|===|!==|==|!=|<=|>=|>>>|>>|<<|\|\||&&|->|\S", old
        )
        pattern = r"\s*".join(re.escape(token) for token in tokens)
        if len(list(re.finditer(pattern, content))) != 1:
            parser.error("Expected exactly one control site")
        path.write_text(
            prefix + re.sub(pattern, lambda _: new, content, count=1) + suffix
        )
    print("Applied isolated negative control: " + args.fault)


if __name__ == "__main__":
    main()
