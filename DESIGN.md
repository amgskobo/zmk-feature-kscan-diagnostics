# DESIGN: zmk-feature-kscan-diagnostics

Diagnose keyscan (kscan) hardware problems of a ZMK keyboard from a web page:
broken/unstable wires, bad solder joints on key sockets/switches, switch
chatter, and "none of the above → probably software config". The firmware
module collects kscan **topology** and **per-key event statistics** and exposes
them over the custom ZMK Studio RPC protocol; all fault-estimation logic lives
in the **web UI**, which renders the physical key layout (official Studio
protocol), overlays the electrical wiring, and visualizes key presses live.

This document is the source of truth for the implementation phases. Keep it
updated when a phase deviates from the plan.

## 1. Scope

- **Feature module** (no new kscan driver, no DT bindings of its own, no
  shields). It observes the kscan devices that are already in the user's build.
- Supports **all official ZMK kscan implementations** at compile time:
  `zmk,kscan-gpio-matrix`, `zmk,kscan-gpio-direct`, `zmk,kscan-gpio-charlieplex`,
  `zmk,kscan-gpio-demux`, `zmk,kscan-mock`, plus the wrappers
  `zmk,kscan-composite` (resolved into its children with row/col offsets) and
  `zmk,kscan-sideband-behaviors` (unwrapped to its inner kscan).
- Live key-event streaming is **NOT implemented here**. The web UI consumes
  [zmk-feature-input-stream](https://github.com/cormoran/zmk-feature-input-stream)
  (subsystem identifier `zmk__input_stream`) when the firmware includes it.
  This module only adds what input-stream does not have: topology and
  accurate-time statistics (see §3.1 for why both are needed).
- **Split peripheral diagnostics** (§11): the same topology + statistics from
  the peripheral half/halves, obtained by relaying the query to the peripheral
  over the ZMK split event-relay and returning its reply to the PC as an RPC
  notification. Firmware + protocol only in this iteration; the web UI that
  consumes it is a follow-up.
- Out of scope for v1 (backlog, §9): active GPIO self-test (driving lines while
  the kscan driver runs is unsafe), raw pre-debounce scan visibility (needs a
  kscan wrapper driver), upstream input-stream improvements (timestamp +
  sequence number).

### Known limitations (documented in README, surfaced in web UI)

1. **Post-debounce visibility only.** `zmk_position_state_changed` fires after
   the driver's debounce. Chatter shorter than the debounce window is invisible;
   chatter that *is* visible (double-fire) is exactly the chatter that bothers
   the user, so this is acceptable.
2. **input-stream events carry no timestamps** and its notification queue drops
   silently when full. Live view uses browser receive time (good enough for
   visualization); all timing analysis uses this module's firmware-side
   counters, which are ground truth.
3. **Split keyboards**: position events from the peripheral half reach the
   central (with `source != LOCAL`) and are counted in the central's stats,
   but the peripheral's GPIO/wiring topology and its *own* per-key counters
   live in the other firmware image. §11 adds a relay path that queries the
   peripheral image directly for that data; until the web UI consumes it, the
   central's view still labels the peripheral half "wiring info unavailable".
   Sub-5 ms chatter buckets remain unreliable for peripheral positions counted
   on the *central* side (split transport jitter); the peripheral's own
   counters (§11) do not have that jitter because they are collected locally on
   the peripheral before transport.
4. **Ghost keys on unmapped matrix cells are invisible** — `app/src/kscan.c`
   drops (row,col) pairs with no transform entry. Phantom presses on *mapped*
   positions can be recorded as candidates during an explicit live Ghost check.

## 2. Architecture overview

```
firmware                                      web (React + TS, vite)
┌───────────────────────────────┐             ┌──────────────────────────────┐
│ topology.c   compile-time DT  │  custom RPC │ useKscanDiagnostics          │
│              tables (§4)      │◄───────────►│  (topology + stats fetch)    │
│ stats.c      per-position     │             │ useInputStream (live events) │
│              counters (§5)    │             │ useOfficialKeymap            │
│ studio/kscan_diagnostics_     │  official   │  (GetPhysicalLayouts/Keymap) │
│   handler.c  RPC handler (§6) │  Studio RPC │ KeyboardView (SVG overlay)   │
│ [zmk-feature-input-stream]────┼─notifs─────►│ TestWizard + DiagnosisEngine │
└───────────────────────────────┘             └──────────────────────────────┘
```

- Subsystem identifier: `cormoran__kscan_diagnostics` (27 chars < 32 limit).
- Security: `ZMK_STUDIO_RPC_HANDLER_SECURED` by default; opt out with
  `CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC_UNSECURED=y`. Rationale for the
  override: a broken keyboard may be unable to type the `&studio_unlock`
  combo, and topology and aggregate counters are not highly sensitive. Note:
  input-stream is SECURED, so the *live*
  view needs an unlock — the wizard must degrade to the stats-only path and
  tell the user (or suggest `CONFIG_ZMK_STUDIO_LOCKING=n` in a diagnostics
  build).
- No firmware-initiated notifications in v1 (input-stream covers live events).

### 3.1 Division of labor (why two data paths)

| Need | Source | Why |
|---|---|---|
| Render keyboard | official Studio `keymap.GetPhysicalLayouts` / `GetKeymap` | same data zmk.studio uses; no duplication |
| Which wire/pin is each key on | this module: topology RPC | only the firmware's DT knows it |
| Live press visualization | input-stream notifications | already exists; drops/latency OK for eyes |
| Chatter timing, exact counts | this module: stats RPC | notification drops + no timestamps make web-side timing wrong; firmware counters are lossless |

## 3. Firmware: Kconfig surface

| Symbol | Type | Default | Meaning |
|---|---|---|---|
| `ZMK_KSCAN_DIAGNOSTICS` | bool | n | master switch; stats collection (depends on `ZMK`) |
| `ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC` | bool | y if `ZMK_KSCAN_DIAGNOSTICS && ZMK_STUDIO` | RPC subsystem. **Depends only on `ZMK_STUDIO`**, not on any kscan compat, so native_sim builds with zero devices (stub returns 0 devices — template rule) |
| `ZMK_KSCAN_DIAGNOSTICS_MAX_POSITIONS` | int | 128 | stats table size (≈28 B/position RAM, see §5) |
| `ZMK_STUDIO_RPC_TX_BUF_SIZE` | — | **recommended 256** (throughput only) | The Studio RPC streams the encoded Response through this ring buffer with backpressure (`SIZE_MAX` pb_ostream, `rpc_tx_buffer_write` in `app/src/studio/rpc.c`), so a Response is **not** size-bounded by it — a bigger buffer only means fewer 1 ms backpressure stalls (see the "Studio RPC TX buffer bottleneck" note). Not a correctness requirement; no TX `BUILD_ASSERT`. |
| RX buf | — | keep template default (128) | our requests are ≤16 B |

No runtime custom settings in v1: the chatter threshold is applied **web-side**
against fixed firmware histogram buckets (§5), so nothing needs tuning on the
device. (`zmk-feature-custom-settings` stays out of the dependency set.)

## 4. Firmware: topology collection (`src/topology.c`)

All wiring data is extracted **at compile time with DT macros** — kscan driver
config structs are private, there is no runtime API. Public accessors in
`include/cormoran/kscan_diagnostics/topology.h`; everything returns data from
`static const` tables.

Per-compat `DT_FOREACH_STATUS_OKAY` builds a **leaf device table**:

| Field | Source |
|---|---|
| `const struct device *dev` | `DEVICE_DT_GET(n)` |
| node name | `DT_NODE_FULL_NAME(n)` |
| type enum | which compat matched (MATRIX/DIRECT/CHARLIEPLEX/DEMUX/MOCK) |
| rows/cols/inputs | `DT_PROP_LEN(n, row_gpios)` etc. per compat (direct: `input-gpios` **or** `input-keys` phandles; charlieplex: rows=cols=len(`gpios`); demux: inputs + 2^len(`output-gpios`) virtual cols; mock: `rows`/`columns` props) |
| debounce press/release/scan-period/poll-period | replicate each driver's own macro logic, including the deprecated `debounce-period` fallback and Kconfig fallbacks (`CONFIG_ZMK_KSCAN_DEBOUNCE_*`) — copy the `INST_DEBOUNCE_*` macros from the drivers |
| `diode_row2col`, `toggle_mode` | matrix `diode-direction` enum, direct `toggle-mode` |
| GPIO lines | per line kind (ROW/COL/INPUT/OUTPUT/CHARLIE): `DEVICE_DT_NAME(DT_GPIO_CTLR_BY_IDX(n, prop, i))`, `DT_GPIO_PIN_BY_IDX`, `DT_GPIO_FLAGS_BY_IDX` (report `GPIO_ACTIVE_LOW` bit + raw dt_flags) |

**Wrappers**: a second table for `zmk,kscan-composite` children (`kscan`
phandle → resolved at runtime by comparing `const struct device *` against the
leaf table; `row-offset`/`col-offset` kept) and `zmk,kscan-sideband-behaviors`
(maps wrapper device → inner device). Resolution function:
`topology_resolve(dev)` → list of `{leaf_index, row_offset, col_offset}`.

**Per-layout table** from `DT_FOREACH_STATUS_OKAY(zmk_physical_layout)`:
transform phandle's `rows`/`columns` props, kscan phandle device. At runtime,
match ZMK's `zmk_physical_layouts_get_list()` entries to this table by
comparing the `kscan` device pointer (fall back to index order — both arrays
come from the same DT instances). Mirror ZMK's fallback: when no
`zmk,physical-layout` node exists, ZMK synthesizes one from `chosen` nodes —
replicate that condition (see `app/src/physical_layouts.c`) or document that
Studio (required anyway) needs physical layouts.

**Position map** enumerates the full transform grid from its public DT `map`
property. The core row/column conversion accepts local scan coordinates and
adds transform offsets, so passing global cells there would add the origin
again and can alias the next row. The module instead matches global cells
directly to DT map entries (unmapped stays zero on the wire), and adds the
transform origin once to each resolved local device's wiring offset. It
retains remote-half cells without claiming local wiring. Chosen transform and
scan-only synthesized layouts mirror the selected core's fallback; no opaque
core transform structure is accessed.

**Zero-device rule** (template): when no kscan compat is okay, tables are empty
and every accessor returns 0 devices/layout dims — RPC and native_sim tests
must still build and run.

## 5. Firmware: event statistics (`src/stats.c`)

`ZMK_LISTENER` on `zmk_position_state_changed` (exactly like input-stream's
listener, but always-on when `ZMK_KSCAN_DIAGNOSTICS=y`; counters are cheap).
Per position `p < min(transform len, MAX_POSITIONS)`:

```c
struct ksd_pos_stats {          /* exposed via RPC */
    uint16_t presses, releases;             /* saturating */
    uint16_t min_press_duration_ms;         /* 0xFFFF = none yet */
    uint16_t min_repress_gap_ms;            /* release→press gap, 0xFFFF = none */
    uint16_t repress_lt[4];                 /* gap < 5/10/20/50 ms bucket counts */
    uint8_t  last_source;                   /* zmk event source; UINT8_MAX=local */
};                                          /* 17 B + scratch below */
struct ksd_pos_scratch {                    /* internal */
    uint32_t last_press_ms, last_release_ms; /* truncated ev->timestamp */
};
```

≈28 B/position ⇒ 3.6 KB RAM at the default 128 positions — acceptable for a
temporarily-added diagnostics module; shrink via Kconfig for tiny MCUs.
Fixed buckets (5/10/20/50 ms) let the web pick any threshold without a
firmware setting. `reset` RPC zeroes everything. Guard concurrent access with
a spinlock or by running entirely on the event thread (listener) + reading
snapshot in RPC handler with lock held (copy per-chunk, 2 entries — cheap).

## 6. RPC protocol (`proto/cormoran/kscan_diagnostics/kscan_diagnostics.proto`)

`package cormoran.kscan_diagnostics;` — one `Request`/`Response` oneof pair
(template rule). All messages small; chunked where unbounded. **nanopb rules:
`has_<field>=true` on every sub-message, no 64-bit types, every string/bytes
field gets a `.options` max_size.**

Page sizes (`.options` max_count) bound the in-RAM Response struct and — once
§11's relay is in play — keep each encoded Response within the relay's
reassembly buffer (`CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN`, 240). They are
**not** bound by the Studio RPC TX buffer, which streams the encoding (§3).

| Request | Response | Notes / encoded size |
|---|---|---|
| `GetInfo{}` | `Info{proto_version=1, layout_count, selected_layout, device_count, stats_enabled, max_positions, uptime_ms}` | ~30 B |
| `GetLayout{layout_index}` | `Layout{layout_index, display_name(≤24), rows, columns, key_count, device_indices[≤4] (resolved leaf devices + their offsets: repeated LayoutDevice{leaf_index,row_offset,col_offset})}` | ~60 B |
| `GetDevice{device_index}` | `Device{device_index, node_name(≤24), type, rows, columns, inputs, debounce_press_ms, debounce_release_ms, debounce_scan_period_ms, poll_period_ms, diode_row2col, toggle_mode}` | ~70 B |
| `GetGpioPins{device_index, kind, offset}` | `GpioPins{total, offset, pins[≤4]{index, port(≤12), pin, active_low, dt_flags}}` | 4×~41 B ≈ 180 B — the largest response; sets `KSCAN_DIAGNOSTICS_RPC_ESTIMATED_MAX_RESPONSE_SIZE` and the relay reply-buffer bound (§11). The 198-byte packed carrier fits the 240-byte relay payload. |
| `GetPositionMap{layout_index, offset}` | `PositionMap{total, offset, cells[≤24]}` — row-major over rows×cols, value = position+1, 0 = unmapped | ≤24×5 B ≈ 130 B |
| `GetStats{offset}` | `Stats{total, offset, entries[≤2] PositionStats{position, presses, releases, min_press_duration_ms, min_repress_gap_ms, repress_lt5/lt10/lt20/lt50, last_source}}` | 2×~62 B ≈ 140 B (each PositionStats has 10 uint32 fields) |
| `QueryPeripheral{req_id, payload}` (§11) | `Ok{}` / `Error` | relay ack; peripheral reply arrives as a `PeripheralEvent` notification |
| `ResetStats{}` | `Ok{}` | |
| (any decode/range error) | `Error{message ≤48}` | |

`enum KscanDriverType { UNKNOWN=0; MATRIX=1; DIRECT=2; CHARLIEPLEX=3; DEMUX=4; MOCK=5; }`
`enum GpioLineKind { KIND_UNKNOWN=0; ROW=1; COL=2; INPUT=3; OUTPUT=4; CHARLIE=5; }`

Handler: `src/studio/kscan_diagnostics_handler.c`, standard template shape
(see input-stream's handler for the decode/dispatch skeleton). Responses use
the shared static response buffer; chunk state must live in the static
response (encoding may run twice — template rule). **No TX-buffer
`BUILD_ASSERT`**: the Studio RPC streams the encoded Response through its TX
ring buffer with backpressure (`SIZE_MAX` pb_ostream in
`app/src/studio/rpc.c`), so a Response is not bounded by
`CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE` (§3). The only place a whole encoded
Response is size-bounded is the split relay reassembly buffer, asserted in
`src/split/kscan_diagnostics_relay_events.h` (§11).

## 7. Web UI (`web/`)

Data hooks (all in `web/src/`):
- `useOfficialKeymap` — official Studio protocol via the connection from
  `useZMKApp()` (`@zmkfirmware/zmk-studio-ts-client`, cormoran fork already in
  the template): `keymap.getPhysicalLayouts` (key x/y/w/h/r for rendering) and
  `keymap.getKeymap` (bindings, for the software-level hints).
- `useKscanDiagnostics` — `findSubsystem("cormoran__kscan_diagnostics")` +
  `ZMKCustomSubsystem.callRPC`; sequences Info → Layout(s) → Device(s) →
  GpioPins(chunks) → PositionMap(chunks) into one `Topology` object; `getStats`
  (chunked) and `resetStats`.
- `useInputStream` — feature-detect `findSubsystem("zmk__input_stream")`;
  enable stream; collect `KeyEventNotification{position, pressed, behavior_id,
  param1, param2}` with `receivedAt = performance.now()`. Generate its ts-proto
  types by pointing `web/buf.gen.yaml` at input-stream's proto **as an
  additional input** (template rule: never vendor-copy protos). If pulling that
  repo in is awkward, vendoring under `web/proto-external/` with a sync note is
  the fallback — decide in Phase D, prefer buf pointing at a git input.

Screens (single-page, sections):
1. **Connect bar** — template standard (WebSerial), lock-state banner.
2. **Keyboard view** — SVG from physical layout; per-key fill by state
   (untested / ok / pressed-now / suspect / dead / unmapped-half); hover shows
   (row,col), GPIO port+pin of its row & col lines, debounce config; "wiring
   mode" toggle draws row/col groupings as colored outlines so a whole broken
   line is visually obvious.
3. **Test wizard** (state machine, the main flow):
   - *coverage*: asks the user to press every key once (order-free); live
     events (or stats-diff polling when input-stream is absent/locked: poll
     `GetStats` at ~2 Hz and diff press counts) mark keys ok.
   - *retest*: for keys not seen, targeted "press key X 5 times"; stats diff
     confirms dead vs intermittent.
   - *chatter*: fetch stats; flag positions with `repress_lt*` counts > 0 (web
     threshold slider picks which bucket matters).
   - *report*: DiagnosisEngine output with concrete actions.
4. **Stats table** — raw per-position counters, reset button, CSV export.

**DiagnosisEngine** (`web/src/diagnosis/*.ts`, pure functions, jest-tested):
input `{topology, coverage, statsBefore/After, eventLog}` → findings ranked:
- ≥2 dead keys all sharing row R (and their columns proven alive elsewhere) →
  `ROW_FAULT(R)` → "check wire/solder on GPIO <port> <pin>"; same for columns.
- isolated dead key with proven-alive row+col → `KEY_FAULT` → "reflow socket /
  swap switch at <key>".
- `repress_lt*` > 0 → `CHATTER` → "replace switch or raise debounce-press-ms
  (currently <n> ms from topology)".
- event at a position the wizard did not request while 3 rectangle-corners
  held → `GHOST` → "check diode at <key>" (only when topology says matrix).
- intermittent line (coverage pass-rate clustered on one row/col across
  retests) → `UNSTABLE_LINE` → "wiggle-test the wire on <port> <pin>".
- keys OK at position level but user reports missing characters → point at
  keymap/behavior (show binding from input-stream event / GetKeymap) →
  `SOFTWARE_SUSPECT`.
Rules must cite which evidence fired; confidence = simple tiers (high/med/low).

## 8. Testing

- **native_sim** (`tests/`, `west zmk-test tests -m .`):
  - zero-device build: RPC handler + stats compile, Info returns 0 devices.
  - mock build: `zmk,kscan-mock` + matrix transform + physical layout in the
    test overlay; scripted mock events drive real `position_state_changed` →
    assert stats counters (incl. a scripted fast re-press) and PositionMap
    correctness through the RPC handler called directly. **Phase C pitfall**:
    `tests/studio/`'s board (`native_sim//zmk_test_mock`) sets `exit-after` on
    the mock kscan device, which calls `exit(0)` shortly after the scripted
    event list is exhausted; a stats test that needs to `k_sleep()` past the
    last scripted event to assert via RPC races that auto-exit (and
    `run-test.sh` has no timeout of its own, so simply deleting `exit-after`
    without replacing it hangs the harness forever). Fix used here:
    `tests/test.dtsi` deletes `exit-after` and the test itself calls `exit()`
    once done (see `src/test/kscan_diagnostics_rpc_test.c`, same pattern as
    `zmk-feature-watchdog`'s `watchdog_test.c`). Also,
    `CONFIG_NATIVE_SIM_SLOWDOWN_TO_REAL_TIME=y` makes this a real
    wall-clock-timed simulation subject to scheduling jitter, so timing
    assertions use tolerant ranges / the widest
    chatter bucket (`<50ms`) rather than exact milliseconds or a narrow
    bucket.
- **Build tests** (`tests/zmk-config/build.yaml`, snippets under
  `tests/zmk-config/snippets/` — template snippet rule; assert in `test.py`):
  - `xiao_ble//zmk` + `tester_xiao` (direct kscan) + RPC on — baseline.
  - snippet `diag-matrix`: matrix kscan node (remember the `RC()` macro clash
    pitfall: `#undef RC` + re-include `matrix_transform.h` in overlays that
    redefine a transform; keep pins within tester_xiao's `xiao_d 0..10`,
    shrinking `&kscan0` if needed).
  - snippet `diag-composite`: composite wrapping direct+matrix with offsets.
  - snippet `diag-charlieplex-demux`: one build compiling both remaining
    compats (instances may coexist; layout selects one).
- **Web**: jest for DiagnosisEngine (table-driven fixtures per §7 rule) and
  hook/component tests via `createConnectedMockZMKApp({subsystems:
  ["cormoran__kscan_diagnostics", "zmk__input_stream"]})`.
- **Hardware acceptance**: follow `docs/validation.md` with separately
  authorized device access and a build matching the inspected board topology.
  - The **mock-kscan** profile supplies scripted events, including chatter-like
    bursts, for checking Info/Device(type=MOCK)/PositionMap/Stats over USB RPC.
    Synthetic scan input does not establish physical switch behavior.
  - The direct-kscan tester profile permits comparing GpioPins with its declared
    `xiao_d` wiring. A separately authorized physical input can check stats
    end-to-end after its electrical configuration has been verified.
  - Derive flash layout, bootloader boundaries and debug symbols from the exact
    selected artifact. A local partition workaround or debug procedure is not
    a universal project requirement. The mock build's startup logging and RTT
    options are fixture settings, not proof of delivery, timing or retention.

## 9. Phase plan (subagent handoff)

Phase A (template init) is **done** by the setup agent. Each phase: read this
file + `skills/zmk-module-dev/SKILL.md` first; work inside the nix devshell
(`nix --extra-experimental-features 'nix-command flakes' develop
../nix --command bash -lc '<cmd>'` from the repo, west already initialized);
run `python3 -m unittest` (+ web commands for web phases); commit at
milestones on `codex/init-kscan-diagnostics` (or a stacked branch); **no push,
no PR** unless asked. pre-commit: `SKIP=prettier,eslint,jest,web-build
pre-commit run --all-files` + run the npm checks directly.

- **B — proto + topology + RPC** (§4, §6 minus stats): proto/.options, Kconfig,
  topology tables, handler with Info/Layout/Device/GpioPins/PositionMap,
  zero-device native_sim test, mock-kscan native_sim test for PositionMap,
  build-test snippets (matrix/composite/charlieplex+demux). Biggest phase;
  the DT macro tables are the hard part — keep per-compat code in separate
  `#if DT_HAS_COMPAT_STATUS_OKAY(...)` blocks.
- **C — stats** (§5) — **done**: listener, counters, GetStats/ResetStats,
  native_sim test with scripted mock events incl. fast re-press bucket
  assertion. Deviations: Stats page shrank to 2 entries (not 3, see §6);
  see §8 for the `exit-after`/native_sim-timing pitfalls hit along the way.
- **D — web UI** (§7) — **done**: `useKscanDiagnostics`/`useOfficialKeymap`/
  `useInputStream` hooks, `KeyboardView` (SVG-like absolute-positioned
  keycap grid, rotation-aware, wiring-mode border overlay), `TestWizard`
  (coverage → retest → chatter → report state machine), `DiagnosisEngine`
  (`web/src/diagnosis/engine.ts`, all six §7 rules, jest-fixtured in
  `web/test/diagnosis/`), `StatsTable` with CSV export, wired into `App.tsx`.
  Deviations:
  - **input-stream proto**: vendored a pinned copy under
    `web/proto-external/zmk/input_stream/` (commit noted in the file header)
    as a second `buf.gen.yaml` input, rather than pointing at a sibling
    checkout path — keeps `npm run generate` reproducible when the sibling
    module repo isn't cloned next to this one (web CI has no west
    workspace).
  - **`GpioPin` has no `kind` field** (only `GetGpioPins`' request has a
    `kind` filter), so `useKscanDiagnostics` fetches GPIO lines once per
    kind (ROW/COL/INPUT/OUTPUT/CHARLIE) instead of one unfiltered page, and
    `KscanDevice.gpioLinesByKind` keeps them separated for
    `resolveRowColLines`.
  - **Pre-existing web build break fixed**: ts-proto's default `export enum`
    output for this module's new `KscanDriverType`/`GpioLineKind` enums
    trips `tsconfig.app.json`'s `erasableSyntaxOnly` (TS1294). Added
    `buf.gen.yaml`'s `enumsAsLiterals=true`, the same fix already used by
    `zmk-feature-watchdog`'s `IncidentType` enum. This broke `npm run build`
    at the start of Phase D (before any Phase D code was added) and was
    fixed as a minimal, in-scope correction.
  - **GHOST rule** needs an explicit requested subset and event window. The
    optional Ghost check records those separately from free coverage, asking
    for three rectangle corners while leaving the selected target untouched.
    Without that check, `requestedPositions` is omitted and GHOST is skipped.
- **E — hardware acceptance** (§8): use the mock profile
  (`kscan_diagnostics_board_hw_mock`, snippet `diag-hw-mock`) separately from
  actual physical switch input. Validate the full RPC chain against the
  declared topology using the procedure in `docs/validation.md`. This document
  does not publish individual device histories or claim a new hardware result.
  Relevant reproducible constraints:
  - **Bug**: `proto/cormoran/kscan-diagnostics/` (hyphen) broke
    `tools/zmk-studio-rpc custom-call`'s proto loader (tries to import an
    invalid Python module path). Renamed to
    `proto/cormoran/kscan_diagnostics/` (matches every other module's
    single-word/underscore convention) and updated the two firmware
    `#include`s + the generated web proto's import sites.
  - **Test-script pitfall, not a firmware bug**: `zmk,kscan-mock`'s `events`
    DT array is one-event-behind (each `events[i]`'s delay controls the wait
    before event `i+1`, not event `i`; `events[0]`'s delay is consumed
    twice; the last event's delay is never consumed).
    `tests/test.dtsi`'s native_sim fixture has the same shift but its
    tolerant assertion ranges permit that model. The board mock
    script (`diag-hw-mock.overlay`) uses it too.
    `src/test/kscan_mock_timing_test.c` (`tests/mock-timing/`) checks the
    scheduling model as a regression test.
- **F — docs + PR**: README user guide (how to add the module + west.yml
  example, how to run a diagnosis session), then PR to origin.

- **G — peripheral diagnostics over split relay** (§11) — **firmware/protocol
  done**: G1 extracted the shared `ksd_query_dispatch` (no behavior change);
  G2 added `QueryPeripheral` (Request) + `PeripheralEvent` (notification) to
  the proto; G3 added `ZMK_KSCAN_DIAGNOSTICS_SPLIT`, the two relay carriers
  (`relay_events.{h,c}`), and the relay TU (`src/split/kscan_diagnostics_relay.c`)
  wiring central query-out/notify and peripheral answer; G5 added the two
  split build-test artifacts. The web UI that consumes `PeripheralEvent` is a
  **follow-up** (not in this iteration).

Backlog (separate issues, not v1): input-stream upstream PR adding
`timestamp_ms` + `seq` to `KeyEventNotification`; kscan wrapper driver for
pre-debounce raw scan streaming; active GPIO line self-test; **web UI for
peripheral diagnostics** (issue the §11 `QueryPeripheral` calls and render the
peripheral halves' wiring/stats).

## 10. Design decisions record

- **SECURED subsystem by default, opt-in UNSECURED override**
  (`CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC_UNSECURED`) — a broken keyboard
  can't necessarily unlock Studio (§2), so the override exists for that case.
  Aggregate counters only; no keylogging surface beyond what input-stream
  (SECURED) already gates.
- **No custom settings dependency** — fixed histogram buckets moved the only
  tunable (chatter threshold) to the web (§5). Cuts scope and RAM.
- **Stats in firmware, diagnosis in web** — notification loss + missing
  timestamps make web-only timing wrong (§3.1); conversely fault rules will
  iterate fast in TS with jest fixtures, so they don't belong in firmware.
- **Compile-time DT tables** — no runtime API exists for kscan wiring; private
  driver structs must not be poked. Cost: per-compat macro code (§4).
- **Chunked polling RPCs, no notifications** — topology is static, stats are
  poll-friendly, and input-stream already owns the live event channel. (§11's
  peripheral path is the one exception: its reply is inherently asynchronous
  across the split link, so it *is* delivered as a notification.)

## 11. Peripheral diagnostics over split event-relay

A split peripheral's kscan wiring is compile-time devicetree in a **separate
firmware image**, so the central cannot read it directly. Instead of a new
protocol, the peripheral runs the **same** topology/stats query dispatch
(`ksd_query_dispatch`, `src/kscan_diagnostics_query.c`) against its own tables,
and the central shuttles the request/reply over ZMK's split event-relay
(`CONFIG_ZMK_SPLIT_RELAY_EVENT`, patched-fork feature). Flow:

```
PC ──QueryPeripheral{req_id, payload=<encoded inner Request>}──► central RPC
     central: raise ksd_relay_query(SELF) ──relay(K2q)──► peripheral(s)
       peripheral: ksd_relay_query re-raised locally (source stamped)
                 → decode inner Request → ksd_query_dispatch (own tables)
                 → encode inner Response → raise ksd_relay_reply(SELF)
     peripheral ──relay(K2r)──► central: ksd_relay_reply re-raised (source=idx+1)
       central: raise_zmk_studio_custom_notification(PeripheralEvent{source,
                req_id, payload=<encoded inner Response>})
PC ◄── PeripheralEvent notification (one per responding peripheral)
```

- **Reused dispatch, not a mirrored protocol.** The relay carries opaque
  encoded `Request`/`Response` bytes — the exact messages the local RPC uses —
  so every existing query (Info/Layout/Device/GpioPins/PositionMap/Stats/
  ResetStats) works against the peripheral with zero duplicate logic. G1
  extracted the dispatch out of the Studio handler so it compiles into a
  peripheral image that has **no `ZMK_STUDIO`** (`select NANOPB` keeps the
  proto buildable there).
- **Async → notification.** The RPC returns `Ok` immediately (`Error` if the
  build is not a split central); replies arrive later as `PeripheralEvent`
  notifications. Since a peripheral cannot know its own source index, the relay
  **broadcasts to all** peripherals and each reply is stamped with its `source`
  (1-based; central is 0) by the central-side relay HANDLE. The client
  correlates replies by `(source, req_id)` and tolerates duplicates/timeouts.
- **Two relay carriers** (`include/cormoran/kscan_diagnostics/relay_events.h`):
  `ksd_relay_query` (id `K2q`, central→peripheral) and `ksd_relay_reply`
  (id `K2r`, peripheral→central), each holding `{source, req_id, len, data[]}`.
  The packed version 2 carriers retain a uint32 central-owned ticket. The central
  maps that fresh ticket back to the complete client request ID. The old
  `KDq`/`KDr` carriers narrowed it to a byte; distinct identifiers prevent a
  mixed-version split from interpreting the new layout as the old one. Both
  halves must use the same module revision; the public protobuf is unchanged.
  The whole struct is copied into the relay payload, so the reply's `data`
  (sized to the largest inner Response, ~180 B) forces
  `CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=240` (the relay transport chunks it
  across the link; a `BUILD_ASSERT` + README note cover the config). The four
  relay macros in `src/split/kscan_diagnostics_relay.c` are self-role-gating,
  so one TU compiles correctly on either role.
- **Kconfig**: `ZMK_KSCAN_DIAGNOSTICS_SPLIT` (default y under `ZMK_SPLIT`)
  `select`s `ZMK_SPLIT_RELAY_EVENT` and `NANOPB`. Central notification path is
  additionally gated on `ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC`.
- **Security/lifetime**: the subsystem follows the central's setting
  (`SECURED` by default, opt-in `UNSECURED`). Four pending tickets expire after
  5 seconds by default. Lock/output changes clear them and the queue; replies
  must match a live ticket and a peer may answer once. Receive-side inner
  lengths are bounded independently of the outer carrier. A captured epoch
  and deadline are rechecked at the first encoder pass, then kept fixed across
  sizing/output to avoid a truncated frame. The core TX call is synchronous
  and cannot be cancelled here; Serial close has no module notification.
- **Threading**: the relay carriers are re-raised by the split relay-receive
  path on the **system work queue** (~2 KB). Answering a query and (on the
  central) raising a Studio notification -- `raise_zmk_studio_custom_notification`
  builds a full `zmk_studio_Notification` + `zmk_studio_Response` and runs a
  double `pb_encode` synchronously -- needs an RPC-thread-sized stack, so the
  event listeners only enqueue to a `k_msgq` and the heavy work runs on a
  dedicated `ksd_relay` work queue (`ZMK_KSCAN_DIAGNOSTICS_RELAY_STACK_SIZE`,
  default 4096). This moves the RPC-sized allocation off the system stack;
  physical transport acceptance remains separate.
- **Testing** (§8): real-kernel native fixtures cover relay receive/worker
  bounds, pending reply retirement, sizing/output lifetime and topology
  offsets/fallbacks with controlled transport and keymap boundaries. Normal
  and ASan/UBSan variants run each binary three times. Two build-test
  artifacts (`kscan_diagnostics_board_split_central` /
  `..._split_peripheral`) prove both role gatings + the `BUILD_ASSERT`s
  compile. The actual two-board transport round-trip, physical wiring and
  timing still require separately authorized device acceptance.
- **Out of scope here**: the web UI that issues `QueryPeripheral` and renders
  peripheral topology/wiring (follow-up).
