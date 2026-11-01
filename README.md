# zmk-feature-kscan-diagnostics

Maintenance fork of [cormoran/zmk-feature-kscan-diagnostics](https://github.com/cormoran/zmk-feature-kscan-diagnostics).
The source baseline is `1432f7fe0cfe903cd7d3c9931ae6bd6f2e1f328e`.
Firmware and protocol interfaces remain compatible, and existing validation
scenarios are retained. Validation must
identify the selected source and dependencies; a fork or a successful build
does not establish physical wiring, timing or transport acceptance.

ZMK module that helps you figure out why a keyboard is misbehaving —
keys that don't register, keys that fire twice, or a whole row/column that's
dead — without an oscilloscope or a debugger. The firmware watches your
keyboard's existing key-scan (kscan) hardware and remembers, per key, how
often it fired and how it timed out. A web page then draws your actual key
layout, overlays which physical wire (row/column GPIO pin) each key sits on,
walks you through a short test, and tells you in plain language what's likely
wrong and what to check first — e.g. "row line on GPIO P0.05 looks broken,
check that wire" instead of "some keys don't work."

This module uses the **unofficial** custom ZMK Studio RPC protocol.

## Summary

This module includes:

- **Firmware**: kscan topology + per-key statistics, exposed over a custom
  Studio RPC handler (`src/studio/kscan_diagnostics_handler.c`)
- **Protocol**: Protobuf definition
  (`proto/cormoran/kscan_diagnostics/kscan_diagnostics.proto`)
- **Web UI**: React + TypeScript app (`web/`) that renders your keyboard,
  overlays wiring, runs a guided test, and estimates the fault — using
  [@cormoran/zmk-studio-react-hook](https://github.com/cormoran/react-zmk-studio)
- **Tests**: Firmware unit tests (`tests/`) and build tests
  (`tests/zmk-config/`)

## Who this is for / prerequisites

This works with **any keyboard built on ZMK's official kscan drivers** —
matrix, direct-pin, charlieplex, demux, and the `composite`/
`sideband-behaviors` wrappers around them — so it should work on essentially
any ZMK board without firmware changes beyond adding this module.

You need:

- A ZMK build that already includes [ZMK Studio](https://zmk.dev/docs/features/studio)
  support (`CONFIG_ZMK_STUDIO=y`) — this module rides on Studio's connection
  (USB or BLE) to talk to the web page.
- A way to connect the keyboard to your computer for the diagnosis session
  (USB cable, or BLE if your Studio transport supports it).

Optional, but recommended if you can add it:

- [zmk-feature-input-stream](https://github.com/cormoran/zmk-feature-input-stream)
  makes the web page's keyboard view **light up live** as you press keys,
  which makes the guided test much easier to follow. Without it, the web UI
  falls back to polling this module's counters a couple of times a second and
  diffing them — it still works and the end diagnosis is identical, just
  without the live visual feedback. Note that input-stream's RPC subsystem is
  **SECURED**, so live view requires unlocking ZMK Studio on the keyboard
  first (or building with `CONFIG_ZMK_STUDIO_LOCKING=n` for a
  diagnostics-only build). This module's own RPC subsystem is also **SECURED**
  by default. If you need to read topology/stats on a keyboard too broken to
  type the unlock combo, set `CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC_UNSECURED=y`
  to expose it while locked.

## Module User Guide

1. Add the dependency to your `config/west.yml`. Note: this module requires a
   patched ZMK with custom Studio RPC support.

   ```yaml
   manifest:
     remotes:
       - name: cormoran
         url-base: https://github.com/cormoran
       - name: amgskobo
         url-base: https://github.com/amgskobo
     projects:
       - name: zmk-feature-kscan-diagnostics
         remote: amgskobo
         revision: 9eaf49df49fcff1f35e8927b2e9b50afe1b05739
         import: true
       # Optional: live key-press visualization in the web UI (see above)
       - name: zmk-feature-input-stream
         remote: amgskobo
         revision: cdb7388c62dadebe08c1d63e7b1a2a97ad87ce47
         import: true
       # Required: patched ZMK with custom Studio RPC support
       - name: zmk
         remote: cormoran
         revision: e5c9b6915b56801193e359dd9bad4a167ce0d1b8
         import:
           file: app/west.yml
   ```

   The module revision above is the committed fork baseline. Maintenance
   continues on `codex/kscan-diagnostics-review`; after explicitly reviewing
   a newer commit, pin its full revision in your integrating manifest and lock.
   The required Custom Settings dependency is imported from its pinned
   `amgskobo` review fork.

2. Enable flags in your `config/<shield>.conf`:

   ```conf
   CONFIG_ZMK_STUDIO=y
   CONFIG_ZMK_KSCAN_DIAGNOSTICS=y
   CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC=y
   # Optional (throughput, not required): the Studio RPC streams responses, so
   # this only makes larger responses transfer with fewer stalls.
   CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE=256

   # Optional: enable zmk-feature-input-stream for live key-press
   # visualization in the web UI (needs unlocking Studio to view).
   CONFIG_ZMK_INPUT_STREAM_FEATURE=y
   CONFIG_ZMK_INPUT_STREAM_FEATURE_STUDIO_RPC=y
   # Encoding nanopb requires more stack space
   CONFIG_ZMK_LOW_PRIORITY_THREAD_STACK_SIZE=2048
   ```

3. Flash your keyboard, then open the
   [web UI](https://cormoran.github.io/zmk-feature-kscan-diagnostics/) (or run
   it locally, see `web/README.md`) and connect over WebSerial.

### Kconfig options

| Symbol | Type | Default | Meaning |
|---|---|---|---|
| `CONFIG_ZMK_KSCAN_DIAGNOSTICS` | bool | `n` | Master switch. Enables kscan topology collection and per-key statistics. |
| `CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC` | bool | `y` (once `ZMK_STUDIO` is enabled) | Exposes the diagnostics data over the custom Studio RPC subsystem so the web UI can read it. Only depends on `ZMK_STUDIO`, not on which kscan driver you use. |
| `CONFIG_ZMK_KSCAN_DIAGNOSTICS_MAX_POSITIONS` | int | `128` | How many keymap positions get a statistics slot (~28 bytes RAM each). Raise it only if your layout has more than 128 positions; lower it to save RAM on very small MCUs. |
| `CONFIG_ZMK_KSCAN_DIAGNOSTICS_SPLIT` | bool | `y` (on a split build) | On a split keyboard, lets the central relay diagnostics queries to the peripheral half/halves and deliver their replies to the web UI (see below). Requires `CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=256` on **both** halves. |

### Split keyboards

On a split keyboard, build **both** halves with this module. The half plugged
into your computer (the central) can then read the *other* half's kscan wiring
and per-key statistics by relaying the query across the split link. Enable it
in the `.conf` that applies to both halves (e.g. a shared `<board>.conf`):

```conf
CONFIG_ZMK_KSCAN_DIAGNOSTICS=y
# Auto-enabled on a split build; needed so the peripheral half answers queries.
CONFIG_ZMK_KSCAN_DIAGNOSTICS_SPLIT=y
# Required on BOTH halves: a peripheral reply carries a full topology page, which
# is larger than ZMK's default relay payload. (The module sets this as a Kconfig
# default, but that can lose Kconfig parse-order, so set it explicitly.)
CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=256
```

The central additionally needs `CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC=y`
(from the base setup above) to forward peripheral replies to the web UI; the
peripheral does not need `CONFIG_ZMK_STUDIO`.

Build both halves from the same module revision. The maintenance version uses
version 2 split relay carriers to preserve the RPC's full 32-bit request ID.
It uses distinct relay identifiers, so an older half cannot decode these
carriers; update both halves together. The Studio RPC messages are unchanged.

> Status: the firmware and RPC for this are complete (a `QueryPeripheral`
> request and `PeripheralEvent` notification on the diagnostics subsystem). The
> web UI that surfaces peripheral-half wiring is still in progress — until then
> the keyboard view continues to label peripheral keys "wiring info
> unavailable".

(There are also two test-only Kconfig symbols,
`CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC_TEST` and
`CONFIG_ZMK_KSCAN_DIAGNOSTICS_MOCK_TIMING_TEST`, used by this repo's own
native_sim tests. Leave both off in a real keyboard build.)

### Web UI

See [web/README.md](./web/README.md) for web UI development instructions.

### Publishing Web UI

**GitHub Pages**: Merge a pull request into `main+custom-studio-protocol` to
deploy to `https://<account>.github.io/<repo>/`.

**Cloudflare Workers (PR previews)**: Configure `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` secrets.

## How to diagnose a keyboard problem

Open the web UI at
[https://cormoran.github.io/zmk-feature-kscan-diagnostics/](https://cormoran.github.io/zmk-feature-kscan-diagnostics/)
(or your own local/self-hosted copy) and click **Connect Serial** to pick your
keyboard over WebSerial.

1. **Keyboard view.** Once connected, the page draws your keyboard's actual
   key layout (the same layout data ZMK Studio itself uses) and colors each
   key by what's currently known about it: untested, OK, pressed right now,
   suspect, dead, or "wiring unavailable" (see limitations below). Hover a
   key to see its row/column, which GPIO port and pin its row line and column
   line are wired to, and its debounce settings. Toggle **wiring mode** to
   draw colored outlines around every key sharing a row or column line — this
   makes it visually obvious when a whole line is affected rather than one
   key.

2. **Run the test wizard.** This is the main guided flow, in four steps:
   - **Coverage** — press every key once, in any order. As each key is
     recognized, it's marked OK. If `zmk-feature-input-stream` is connected
     and unlocked you'll see this happen live; otherwise the page polls the
     firmware's counters a couple of times a second, which works the same
     but with a short delay.
   - **Retest** — for any key that wasn't seen, the wizard asks you to press
     that specific key several times, to tell apart "completely dead" from
     "sometimes works."
   - **Chatter check** — the wizard looks at how quickly each key was
     released and pressed again. A slider lets you pick how strict to be
     (keys that double-fire within 5/10/20/50 ms).
   - **Report** — a plain-language list of findings, each with a suggested
     fix (see below).

3. **Stats table.** A raw table of per-key press/release counts and timing,
   with a reset button and CSV export, if you want the numbers directly.

Live view starts automatically when its subsystem is available. It is used
only after the keyboard acknowledges activation. If activation fails or Studio
is locked, coverage uses statistics polling; unlock and choose **Enable live
view** to retry on the same connection. Leaving the page or replacing the
connection sends a best-effort stop to the original stream.

Each **Start test** reads a statistics baseline, including with live view.
The final report reconciles press counts with the firmware's baseline delta,
so switching from polling to live view cannot count the same press twice.
If an initial topology or layout read fails, use **Reload diagnostics** after
unlocking or recovering the connection. Reloading topology starts a new wizard
run so its wiring and baseline cannot carry over from an older layout.
Chatter reports count new repeats since that baseline. The raw table and CSV
retain the keyboard's lifetime counters: their four fields represent exclusive
bands (`<5`, `5–<10`, `10–<20`, `20–<50` ms), while the wizard sums all
bands below the selected threshold. Saturated counters stop a test even if
they reach their limit during coverage or the final read. Use **Reset counters**
before starting again. Resetting from this page ends the current test and
clears its coverage; wait for the operation to finish, then choose **Start test**
for a fresh baseline. A failed reset still retires the old test and displays
the error. A reset performed by another client cannot always be detected;
start a new test after any such reset. Other failed reads keep the wizard in
its current step so they can be retried.

### Reading the findings

| Finding | What it means | What to check |
|---|---|---|
| **Row fault** / **Column fault** | Two or more dead keys share the same row (or column) wire, and the other wire each of those keys needs has already been proven to work. | The single row/column wire is almost certainly the problem. The finding names the exact GPIO port and pin — check that wire's continuity, its solder joint at the controller, and any connector/diode along that line. |
| **Key fault** | One key is dead, but its row and its column have both been proven to work through other keys. | The fault is local to this one switch: reflow the solder joints under it, check the diode if it's a matrix board, or swap the switch. |
| **Chatter** | A key fires press/release/press again faster than a real human keystroke (faster than your chosen threshold). | Usually a worn or low-quality switch — try cleaning or replacing it. If it's borderline, you can also raise the firmware's debounce time (the finding shows the board's current debounce setting in milliseconds) as a software workaround. |
| **Ghost** | An unexpected key appeared to be pressed while you were holding down other keys that form a rectangle with it on the matrix — the classic "ghosting" caused by current flowing back through unwanted diodes. | Check the diode at the reported key position (missing, backwards, or shorted diode). This only applies to matrix keyboards. |
| **Unstable line** | A row or column wasn't consistently dead, but its keys passed and failed inconsistently across repeated tests. | The wire itself is probably making intermittent contact rather than being fully broken. Gently wiggle/flex the wire and its connector while watching the keyboard view — if keys flicker between OK and dead, you've found the loose spot. |
| **Software suspect** | The keyboard reports the key press correctly (no wiring/chatter finding), but you told the wizard the character/behavior is still wrong. | This isn't a hardware problem — check your keymap or behavior configuration instead. |

Each finding also shows a confidence level (high/medium/low) and the raw
evidence that triggered it, so you can judge it yourself if the suggested fix
doesn't pan out.

### Limitations (things this tool can't see)

- **Demux columns use several address pins.** The per-key overlay shows the
  input GPIO, without assigning one address pin to a decoded column. A decoded
  address is not a single wire. Electrical findings use resolved physical GPIO
  identity, so separate devices in a composite layout do not share a line merely
  because their logical row or column numbers match.

- **It only sees keys after debouncing.** The firmware only knows about a key
  press once its kscan driver's debounce filter has accepted it. Very brief
  chatter shorter than that debounce window is invisible — but that's also
  chatter too short to bother you in practice, so the tool focuses on the
  chatter that actually causes double letters.
- **Live view timing is approximate; the reported stats are exact.** The
  optional live key-press view is for your eyes, to make the test wizard
  pleasant to use — it doesn't carry precise timestamps. All chatter/timing
  findings are computed from counters kept on the keyboard itself, which are
  exact regardless of whether the live view is connected.
- **On a split keyboard, only the half plugged into your computer (the
  "central") gets wiring information.** Keys from the other half (the
  "peripheral") are still counted for press/release/chatter statistics, but
  the web UI can't show you which wire they're on, and its chatter timing is
  only approximate (there's a small extra delay from the wireless/wired link
  between the halves). The keyboard view labels peripheral-half keys "wiring
  info unavailable, timing approximate."
- **A ghost key that lands on a completely unused matrix position is
  invisible.** If your matrix has more physical row/column intersections than
  keys in your layout, a phantom press on one of those unused intersections
  can't be reported — there's no key there for the wizard to color. Phantom
  presses on real, mapped keys (the usual case) are detected normally.

## How it works

The firmware half reads your kscan driver's devicetree configuration at
compile time (there's no runtime API for it) to build a table of which GPIO
line backs each row/column/input, and keeps small per-key counters (press
count, release count, and how fast repeat presses arrive) updated by
listening to the same key events ZMK's keymap already produces. The web UI
asks Studio for your official key layout (so it draws exactly what
zmk.studio would), asks this module for the wiring table and counters over
its own custom RPC subsystem, and — only in the web UI, so the fault rules
can be iterated quickly — turns all of that into the findings described
above. See [DESIGN.md](./DESIGN.md) for the full technical design, protocol
definition, and the reasoning behind these choices, and
[docs/validation.md](./docs/validation.md) for the reproducible validation and
hardware acceptance procedure.

## More Info

For more info on modules, you can read through through the [Zephyr modules page](https://docs.zephyrproject.org/3.5.0/develop/modules.html) and [ZMK's page on using modules](https://zmk.dev/docs/features/modules). [Zephyr's west manifest page](https://docs.zephyrproject.org/3.5.0/develop/west/manifest.html#west-manifests) may also be of use.

## Module Development Guide

### Setup for running test

Run preparation and checks inside Docker using the image digest recorded in
`.github/workflows/fork-review.yml`. Prepare dependencies with
`python3 tools/verify_review_dependencies.py` before `west update`; it
rejects moving support revisions and a Custom Settings review tip which differs
from the pinned fork. Ordinary checks reuse those prepared inputs offline.

#### Option0: Dev container (recommended)

Open this repository in VS Code with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers). The container automatically initializes the west workspace using the isolated layout.

#### Option1: west workspace directory layout

Set west topdir as parent of repository root and download dependencies under `../`.
This layout is useful to reduce disk usage by sharing dependencies with other zephyr modules.
The build result is located in `../build`.

```bash
mkdir west-workspace
cd west-workspace # this directory becomes west workspace root (topdir)
git clone <this repository>
# rm -r .west # if exists to reset workspace
west init -l . --mf west/west-test-workspace.yml
west update --narrow
west zephyr-export
```

#### Option2: isolated directory layout

Set west topdir as repository root and download dependencies under `./dependencies`.
This layout is useful if you don't want to share dependencies to other zephyr modules.
Dev container and github actions uses this layout.
The build result is located in `./build`.

```bash
git clone <this repository>
cd <cloned directory>
west init -l west --mf west-test-isolated.yml
west update --narrow
west zephyr-export
```

### Pre-commit

Every commit need to pass pre-commit verification. The verification contains formatting code and running tests.

```
pip install pre-commit
pre-commit install
pre-commit install-hooks

# Run pre-commit manually
pre-commit run --all-files
# Run for git staged files
pre-commit run
```

### Running Test

```bash
# Run unit test + build test and verify the results
python3 -m unittest
# Run build test directly
west zmk-build tests/zmk-config
# Run unit test directly
west zmk-test tests -m .
# Run web tests
cd web && npm test
```

The owner entry builds all ten board profiles and executes all three native
fixtures. It uses a fresh temporary output directory, printed at startup;
`OWNER_TEST_OUTPUT` may select a fresh directory outside this checkout.
It preserves earlier outputs and records each west command, exit and ordered
output. Builds use one target at a time and default to two compiler jobs;
keep `CMAKE_BUILD_PARALLEL_LEVEL` within the container's CPU budget.

### Sync changes from template

Run `Actions > Sync Changes in Template > Run workflow` to get the latest template changes as a pull request.

If the template contains changes in `.github/workflows/*`, register a GitHub personal access token as `GH_TOKEN` repository secret (`repo` + `workflow` scopes).

### Coding agent on actions

Actions for github copilot and claude are available.

- Mention `@copilot`
- Setup `ANTHROPIC_API_KEY` secret and mention `@claude`
  - Or fix [claude.yml](./.github/workflows/claude.yml) to use `CLAUDE_CODE_OAUTH_TOKEN`
