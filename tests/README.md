# Owner validation

Run all automated checks in a prepared Docker workspace with the dependencies
selected by `west/west-test-workspace.yml`. Record actual image digest, resolved
commits, owner source identity, commands, exits and ordered output. Ordinary
runs do not fetch dependencies. DYA custom Studio RPC is the supported core;
stock ZMK is NOT APPLICABLE.

Canonical firmware entry, from the owner root:

```sh
OWNER_TEST_OUTPUT="$EVIDENCE/owner" python3 -m unittest -v
```

Use a fresh output directory outside the source; existing evidence is rejected.
All three original native fixtures (`test`, `studio`, `mock-timing`), their
assertions/snapshots and all ten original board profiles remain. Split profiles
now assert the corrected 240-byte relay capacity on both roles. Direct
`west zmk-test tests -m .` and `west zmk-build tests/zmk-config` are diagnostic
entries; they do not replace the owner's configuration/result assertions.

The canonical entry also runs `bash tests/review/run.sh`. This builds five
standalone real-Zephyr variants: central secured, central UNSECURED opt-in,
peripheral, chosen-transform fallback and scan-only fallback. Each is built
normally and with ASan/UBSan: ten distinct binaries, each executed three times
from separate empty working directories. Required sanitizer/toolchain inputs
must be prepared explicitly; missing inputs block dependent checks. No mock
result may substitute for a missing sanitizer execution.

The fixture compiles production topology, query and relay sources, actual
nanopb, kernel work/message queues/spinlocks and the selected core's event
manager and wired-envelope header. A separate fixture translation unit registers
the real `zmk` logger once; the included production relay keeps its normal
declaration. Only kscan device initialization, counters,
Studio transport/registry and physical split delivery are controlled. The
core's actual wired size assertions compile with capacity 240 and the default
four-character event-name capacity. Assertions cover:

- Full paged global maps on both halves, sparse cells, row/column edges,
  UINT32_MAX coordinates, distinct local 2x2 scan extents, nonzero row and
  column origins, wiring origin exactly once and chosen/scan-only fallbacks.
- An exact-size carrier with claimed inner length 33 and sixteen valid
  unknown varints in its 32-byte data array: receive rejects it, and the worker
  independently rejects a directly queued inconsistent carrier. Valid queries
  still decode, dispatch and echo the full uint32 ticket.
- Lock while queued or waiting at the transport, lock/unlock before a late
  reply, reused public request IDs, replacement tickets, peer duplicate
  suppression, four pending slots, deadline expiry, endpoint changes and
  independent receive-side reply length bounds.
- A single encoder authorization decision across sizing/output. A committed
  frame completes with matching lengths; future or uncommitted payloads retire.

For focused execution, `KSCAN_REVIEW_OUTPUT="$EVIDENCE/review" bash
tests/review/run.sh` retains generated build evidence and all repeated runs.
`KSCAN_REVIEW_SOURCE_ROOT` can select an isolated source variant while keeping
the unchanged fixture. It does not select a dependency or alter pins.

Web entries run from `web/` after explicit lockfile setup:

```sh
npm run generate
npm test -- --runInBand
npm run build
npm run lint
```

All prior Web/engine assertions remain. Added actual-App tests exercise lock
retirement of held/live state, activation and baseline/final reads, explicit
unlock retry, tokenized renewal and a late renewal after lock. Wizard tests
record a mapped ghost in an explicit requested-key window and verify that
free coverage without that window cannot become a ghost finding. The vendored
input-stream schema preserves the old fields and adds only uint32/scalar
lease/layer fields; its baseline and compatibility are documented in its header.
The wizard retires an active ghost window during the live-availability state
transition, before committing controls for a stopped stream. Its interruption
regression records a ghost-pattern candidate, stops live view, reenables it and
requires a discarded window with no automatic recording or ghost finding.

Use the repository's required prepared pre-commit entry after formatting:
`pre-commit run --all-files`. No snapshot auto-accept is permitted. Check owner
source drift after every run; generated/build evidence stays in container
storage and must be reviewed before export.

## Isolated negative controls

From the unchanged owner, run `python3 tests/review_negative_control.py FAULT
"$ISOLATED_OWNER"` against a fresh isolated container source copy. The operator
rejects the authoring source. Re-run the unchanged corresponding owner suite
and retain all repetitions and the first actual failure:

| Fault | Required failure |
|---|---|
| `late-lock` | Central transport-wait payload reaches an executable retired-epoch assertion. |
| `inner-length` | Peripheral receive-side length assertion fails. |
| `inner-worker` | ASan reports the out-of-bounds decode in the independently injected worker carrier. Run the sanitizer variant even if a normal build happens to reject the malformed protobuf. |
| `map-offset` | Global-map coordinates fail on the nonzero-origin layout. |
| `fallback` | Chosen-transform layout count/map assertions fail. |
| `web-lock` | Actual App retains live state or accepts a retired activation. |
| `ghost-window` | Actual Wizard no longer emits the expected mapped GHOST finding. |
| `wired-size` | The selected core's actual wired-envelope BUILD_ASSERT rejects capacity 256. This control intentionally expects compilation rejection. Run the isolated copy's review entry so its modified CMake capacity is selected. |

For every control except `wired-size`, a compiler/setup failure is not evidence
of a detected defect. Format-insensitive mutation matching does not weaken any
fixture assertion. Normal kernel controls retain three executions per binary;
the worker bound requires its memory-sanitizer execution.

## Acceptance limits

These checks establish software bounds/lifetimes under controlled APIs. They
do not prove physical USB/BLE or wired split delivery, GPIO wiring, electrical
ghosting, power, retention, latency or interruption of a blocked core send.
Follow `docs/validation.md` with separately authorized matching device access;
unavailable container transports are BLOCKED. Internal tickets are scoped to
lock/output changes and a bounded deadline, not a core Serial-close event.
