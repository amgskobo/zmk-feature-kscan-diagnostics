# zmk-feature-kscan-diagnostics - Web Frontend

React + TypeScript web app that connects to a keyboard over ZMK Studio
(WebSerial), reads this module's kscan topology/statistics RPC plus the
official Studio keymap RPC, and renders the keyboard view, wiring overlay,
guided test wizard, and diagnosis report described in the top-level
[README.md](../README.md). This doc is for people hacking on the web app
itself — for end-user usage of the hosted page, see the top-level README.

## Features

- **Device Connection**: Connect to ZMK devices via Bluetooth (GATT) or Serial
- **Keyboard + wiring view** (`src/KeyboardView.tsx`): renders the official
  physical layout and colors each key by test status; "wiring mode" draws
  outlines around keys sharing a row/column line
- **Guided test wizard** (`src/TestWizard.tsx`): coverage → retest → chatter
  → report state machine
- **Diagnosis engine** (`src/diagnosis/engine.ts`, `src/diagnosis/types.ts`):
  pure, jest-tested rules that turn topology + stats + coverage into findings
  (row/column fault, key fault, chatter, ghost, unstable line, software
  suspect)
- **Stats table** (`src/StatsTable.tsx`): raw per-position counters with CSV
  export (`src/statsCsv.ts`)
- **Custom RPC**: talks to the firmware module using protobuf
  (`src/useKscanDiagnostics.ts`), the official Studio keymap RPC
  (`src/useOfficialKeymap.ts`), and the optional
  [zmk-feature-input-stream](https://github.com/cormoran/zmk-feature-input-stream)
  live event stream (`src/useInputStream.ts`)
- **react-zmk-studio**: Uses the `@cormoran/zmk-studio-react-hook` library for
  simplified ZMK integration

## Quick Start

```bash
# Install dependencies
npm install

# Generate TypeScript types from proto
npm run generate

# Run development server
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## Project Structure

```
src/
├── main.tsx                  # React entry point
├── App.tsx                   # Top-level layout: connection bar + sections
├── App.css                   # Styles
├── KeyboardView.tsx           # SVG-like keyboard render + wiring overlay
├── TestWizard.tsx              # coverage/retest/chatter/report state machine
├── StatsTable.tsx              # raw per-position counters + CSV export
├── statsCsv.ts                 # CSV export helper
├── useKscanDiagnostics.ts       # this module's custom RPC (topology + stats)
├── useOfficialKeymap.ts         # official Studio keymap/physical-layout RPC
├── useInputStream.ts            # optional zmk-feature-input-stream live events
├── kscanDiagnosticsTypes.ts      # topology/wiring helpers shared by the UI
├── diagnosis/
│   ├── types.ts                 # DiagnosisEngine input/output types
│   └── engine.ts                # fault-estimation rules (pure functions)
└── proto/                       # Generated protobuf TypeScript types (gitignored)
    └── cormoran/kscan_diagnostics/
        └── kscan_diagnostics.ts

proto-external/                  # Vendored copy of zmk-feature-input-stream's
                                  # proto (pinned commit noted in file header),
                                  # used as a second buf.gen.yaml input

test/
├── App.spec.tsx                 # Tests for the top-level App component
├── KeyboardView.spec.tsx        # Tests for the keyboard/wiring view
├── TestWizard.spec.tsx          # Tests for the wizard state machine
├── StatsTable.spec.tsx          # Tests for the stats table + CSV export
└── diagnosis/
    ├── engine.spec.ts           # Table-driven fixture tests for every rule
    └── fixtures.ts              # Shared DiagnosisInput fixtures
```

## How It Works

### 1. Protocol Definition

This module's protobuf schema is defined in
`../proto/cormoran/kscan_diagnostics/kscan_diagnostics.proto`. The optional
live-event schema is pulled from zmk-feature-input-stream (vendored under
`proto-external/`, see that directory for the pinned commit).

### 2. Code Generation

TypeScript types are generated using `ts-proto`:

```bash
npm run generate
```

This runs `buf generate`, which uses the configuration in `buf.gen.yaml`
(pointed at both `../proto` and `proto-external/`).

### 3. Using react-zmk-studio

The app uses the `@cormoran/zmk-studio-react-hook` library:

```typescript
import { useZMKApp, ZMKCustomSubsystem } from "@cormoran/zmk-studio-react-hook";

// Connect to device
const { state, connect, findSubsystem, isConnected } = useZMKApp();

// Find this module's subsystem
const subsystem = findSubsystem("cormoran__kscan_diagnostics");

// Create service and make RPC calls
const service = new ZMKCustomSubsystem(state.connection, subsystem.index);
const response = await service.callRPC(payload);
```

`useKscanDiagnostics.ts` wraps this into a `Topology` object (Info → Layout(s)
→ Device(s) → GpioPins → PositionMap, all chunk-assembled) plus `getStats`/
`resetStats`. `useInputStream.ts` does the equivalent for the optional
`zmk__input_stream` subsystem, feature-detecting it via `findSubsystem` so the
app degrades gracefully when it's absent, locked, or activation fails.
Live view is enabled after an acknowledged request, and is stopped when the
page or connection is retired. Held-key state is kept separately from the
500-event display history.

The wizard captures a statistics baseline in both live and polling modes.
Its chatter thresholds sum the firmware's exclusive histogram bands and use
session deltas. Failed or incomplete reads cannot become an empty baseline;
counter resets initiated on this page retire the run immediately, including
pending reads. A new test is available after the reset request finishes, even
if it failed; the error stays visible. Saturation is checked at the baseline,
while polling, and at the final snapshot for the positions under test. A
saturated run requires a counter reset and a fresh baseline. Resets from
another client are not always detectable; start a new test after any such reset.

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Writing Tests

Use the test helpers from `@cormoran/zmk-studio-react-hook/testing`:

```typescript
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";

const mockZMKApp = createConnectedMockZMKApp({
  deviceName: "Test Device",
  subsystems: ["cormoran__kscan_diagnostics", "zmk__input_stream"],
});

render(
  <ZMKAppProvider value={mockZMKApp}>
    <YourComponent />
  </ZMKAppProvider>
);
```

The `DiagnosisEngine` rules (`src/diagnosis/engine.ts`) are plain,
framework-free functions and are tested directly with table-driven fixtures
in `test/diagnosis/fixtures.ts` — no mock ZMK app needed for those.
