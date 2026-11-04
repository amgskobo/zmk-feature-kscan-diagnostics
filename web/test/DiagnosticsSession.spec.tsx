import type { ContextType } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { call_rpc, MetaError } from "@zmkfirmware/zmk-studio-ts-client";
import { ErrorConditions } from "@zmkfirmware/zmk-studio-ts-client/meta";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import { ZMKAppContext } from "@cormoran/zmk-studio-react-hook";
import { DiagnosticsSections } from "../src/App";
import {
  Request,
  Response,
  GpioLineKind,
  KscanDriverType,
} from "../src/proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import {
  Request as StreamRequest,
  Response as StreamResponse,
  Notification,
} from "../src/proto/zmk/input_stream/input_stream";
import { makeStatsMap } from "./diagnosis/fixtures";
import type { StatsByPosition } from "../src/kscanDiagnosticsTypes";

jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  call_rpc: jest.fn(),
  MetaError: class MetaError extends Error {
    condition: unknown;
    constructor(condition: unknown) {
      super("Synthetic lock error");
      this.condition = condition;
    }
  },
}));
jest.mock("@zmkfirmware/zmk-studio-ts-client/transport/serial", () => ({
  connect: jest.fn(),
}));

type Application = NonNullable<ContextType<typeof ZMKAppContext>>;
type Callback = (notification: { payload: Uint8Array }) => void;
interface Envelope {
  custom?: { call?: { subsystemIndex: number; payload: Uint8Array } };
  keymap?: { getPhysicalLayouts?: boolean };
}
interface Model {
  topologyFailure: boolean;
  connection: object;
  app: Application;
  requests: { subsystemIndex: number; payload: Uint8Array }[];
  callbacks: Map<number, Callback>;
  coreCallbacks: Set<(notification: { lockStateChanged: LockState }) => void>;
  leaseEpoch?: number;
  streamMode: "ok" | "locked" | "error" | "empty" | "missing";
  streamPending?: Promise<Uint8Array>;
  statsMode: "ok" | "error" | "incomplete";
  stats: StatsByPosition;
  statsPending?: Promise<StatsByPosition>;
  statsReads: number;
  resetPending?: Promise<void>;
  resetFailure?: boolean;
}
const models = new Map<unknown, Model>();
const acknowledgement = () =>
  StreamResponse.encode(StreamResponse.create({ ok: {} })).finish();

function model(streamPresent = true): Model {
  const result: Model = {
    topologyFailure: false,
    connection: {},
    app: null as unknown as Application,
    requests: [],
    callbacks: new Map(),
    coreCallbacks: new Set(),
    streamMode: "ok",
    statsMode: "ok",
    stats: new Map(
      [...makeStatsMap().entries()]
        .slice(0, 2)
        .map(([p, s]) => [p, { ...s, presses: 0, releases: 0 }])
    ),
    statsReads: 0,
  };
  const diagnostics = { index: 0, identifier: "cormoran__kscan_diagnostics" };
  const stream = { index: 1, identifier: "zmk__input_stream" };
  result.app = {
    state: { connection: result.connection },
    findSubsystem: (name: string) =>
      name === diagnostics.identifier
        ? diagnostics
        : streamPresent && name === stream.identifier
          ? stream
          : undefined,
    onNotification: ({
      type,
      subsystemIndex,
      callback,
    }: {
      type: string;
      subsystemIndex?: number;
      callback: Callback &
        ((notification: { lockStateChanged: LockState }) => void);
    }) => {
      if (type === "core") {
        result.coreCallbacks.add(callback);
        return () => result.coreCallbacks.delete(callback);
      }
      result.callbacks.set(subsystemIndex!, callback);
      return () => {
        result.callbacks.delete(subsystemIndex!);
      };
    },
  } as unknown as Application;
  models.set(result.connection, result);
  return result;
}

async function rpc(connection: unknown, envelope: Envelope) {
  const current = models.get(connection)!;
  if (envelope.keymap?.getPhysicalLayouts)
    return {
      keymap: {
        getPhysicalLayouts: {
          activeLayoutIndex: 0,
          layouts: [
            {
              name: "Synthetic layout",
              keys: [0, 1].map((x) => ({
                x: x * 100,
                y: 0,
                width: 100,
                height: 100,
                r: 0,
                rx: 0,
                ry: 0,
              })),
            },
          ],
        },
      },
    };
  const call = envelope.custom?.call;
  if (!call) return {};
  current.requests.push(call);
  if (call.subsystemIndex === 1) {
    const request = StreamRequest.decode(call.payload);
    let payload: Uint8Array | undefined = acknowledgement();
    if (request.enableStream) {
      if (current.streamPending) payload = await current.streamPending;
      else if (current.streamMode === "locked")
        throw new MetaError(ErrorConditions.UNLOCK_REQUIRED);
      else if (current.streamMode === "error")
        payload = StreamResponse.encode(
          StreamResponse.create({
            error: { message: "Synthetic stream failure" },
          })
        ).finish();
      else if (current.streamMode === "empty") payload = undefined;
      else if (current.streamMode === "missing")
        payload = StreamResponse.encode(StreamResponse.create({})).finish();
      else if (current.leaseEpoch)
        payload = StreamResponse.encode(
          StreamResponse.create({
            ok: {
              streamEpoch: current.leaseEpoch,
              leaseMs: 15000,
            },
          })
        ).finish();
    }
    return { custom: { call: { payload } } };
  }
  const request = Request.decode(call.payload);
  let response: Response;
  if (request.getInfo && current.topologyFailure)
    response = Response.create({
      error: { message: "Synthetic topology failure" },
    });
  else if (request.getInfo)
    response = Response.create({
      info: {
        protoVersion: 1,
        layoutCount: 1,
        deviceCount: 1,
        statsEnabled: true,
        maxPositions: 2,
      },
    });
  else if (request.getLayout)
    response = Response.create({
      layout: {
        displayName: "Synthetic",
        rows: 1,
        columns: 2,
        keyCount: 2,
        deviceIndices: [{ leafIndex: 0 }],
      },
    });
  else if (request.getPositionMap)
    response = Response.create({ positionMap: { total: 2, cells: [1, 2] } });
  else if (request.getDevice)
    response = Response.create({
      device: { type: KscanDriverType.DIRECT, rows: 1, columns: 2, inputs: 2 },
    });
  else if (request.getGpioPins) {
    const pins =
      request.getGpioPins.kind === GpioLineKind.INPUT
        ? [10, 11].map((pin, index) => ({ index, port: "gpio0", pin }))
        : [];
    response = Response.create({ gpioPins: { total: pins.length, pins } });
  } else if (request.getStats) {
    current.statsReads++;
    if (current.statsMode === "error")
      response = Response.create({
        error: { message: "Synthetic statistics failure" },
      });
    else if (current.statsMode === "incomplete")
      response = Response.create({ stats: { total: 2, entries: [] } });
    else {
      const pending = current.statsPending;
      current.statsPending = undefined;
      const snapshot = pending ? await pending : current.stats;
      response = Response.create({
        stats: { total: snapshot.size, entries: [...snapshot.values()] },
      });
    }
  } else if (request.resetStats) {
    await current.resetPending;
    if (current.resetFailure)
      response = Response.create({
        error: { message: "Synthetic reset failure" },
      });
    else {
      current.stats = new Map(
        [...current.stats].map(([position, entry]) => [
          position,
          {
            ...entry,
            presses: 0,
            releases: 0,
            repressLt5: 0,
            repressLt10: 0,
            repressLt20: 0,
            repressLt50: 0,
            minPressDurationMs: 0xffff,
            minRepressGapMs: 0xffff,
          },
        ])
      );
      response = Response.create({ ok: {} });
    }
  } else response = Response.create({ ok: {} });
  return { custom: { call: { payload: Response.encode(response).finish() } } };
}

const view = (current: Model) => (
  <ZMKAppContext.Provider value={current.app}>
    <DiagnosticsSections />
  </ZMKAppContext.Provider>
);
async function flush() {
  for (let i = 0; i < 32; i++) await Promise.resolve();
}
async function ready() {
  await act(flush);
  expect(screen.getByText("Start test")).toBeInTheDocument();
}
async function start() {
  await act(async () => {
    fireEvent.click(screen.getByText("Start test"));
    await flush();
  });
}
async function key(current: Model, position: number, pressed: boolean) {
  await act(async () => {
    current.callbacks.get(1)?.({
      payload: Notification.encode(
        Notification.create({ keyEvent: { position, pressed } })
      ).finish(),
    });
    await flush();
  });
}
function streamRequests(current: Model) {
  return current.requests
    .filter((r) => r.subsystemIndex === 1)
    .map((r) => StreamRequest.decode(r.payload));
}
async function lock(current: Model, locked: boolean) {
  await act(async () => {
    for (const callback of current.coreCallbacks)
      callback({
        lockStateChanged: locked
          ? LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED
          : LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED,
      });
    await flush();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  models.clear();
  jest.mocked(call_rpc).mockImplementation(rpc);
});
afterEach(() => {
  jest.useRealTimers();
});

it("starts live view and clears a released key while retaining coverage", async () => {
  const current = model();
  render(view(current));
  await ready();
  expect(streamRequests(current).filter((r) => r.enableStream)).toHaveLength(1);
  expect(screen.queryByText("Enable live view")).not.toBeInTheDocument();
  await start();
  await key(current, 0, true);
  expect(screen.getByTestId("keycap-0")).toHaveAttribute(
    "data-state",
    "pressed"
  );
  await key(current, 0, false);
  expect(screen.getByTestId("keycap-0")).toHaveAttribute("data-state", "ok");
  expect(screen.getByText(/1 \/ 2 seen/)).toBeInTheDocument();
});

it.each(["locked", "error", "empty", "missing"] as const)(
  "keeps coverage polling after an unsuccessful stream activation (%s)",
  async (mode) => {
    const current = model();
    current.streamMode = mode;
    render(view(current));
    await ready();
    await start();
    current.stats.get(0)!.presses = 1;
    await act(async () => {
      jest.advanceTimersByTime(600);
      await flush();
    });
    expect(current.statsReads).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/1 \/ 2 seen/)).toBeInTheDocument();
    expect(screen.getByText("Enable live view")).toBeEnabled();
  }
);

it("can enable live view after unlocking the same connection", async () => {
  const current = model();
  current.streamMode = "locked";
  render(view(current));
  await ready();
  current.streamMode = "ok";
  await act(async () => {
    fireEvent.click(screen.getByText("Enable live view"));
    await flush();
  });
  await start();
  await key(current, 1, true);
  expect(screen.getByText(/1 \/ 2 seen/)).toBeInTheDocument();
  expect(screen.queryByText("Enable live view")).not.toBeInTheDocument();
});

it("keeps a long-held key visible beyond the bounded event history", async () => {
  const current = model();
  render(view(current));
  await ready();
  await key(current, 0, true);
  await act(async () => {
    for (let i = 0; i < 501; i++)
      current.callbacks.get(1)?.({
        payload: Notification.encode(
          Notification.create({ keyEvent: { position: 1, pressed: false } })
        ).finish(),
      });
  });
  expect(screen.getByTestId("keycap-0")).toHaveAttribute(
    "data-state",
    "pressed"
  );
  await key(current, 0, false);
  expect(screen.getByTestId("keycap-0")).not.toHaveAttribute(
    "data-state",
    "pressed"
  );
});

it.each(["error", "incomplete"] as const)(
  "does not turn a failed statistics read into a wizard baseline (%s)",
  async (mode) => {
    const current = model();
    render(view(current));
    await ready();
    current.statsMode = mode;
    await start();
    expect(screen.queryByText(/Coverage pass/)).not.toBeInTheDocument();
    current.statsMode = "ok";
    await start();
    expect(screen.getByText(/Coverage pass/)).toBeInTheDocument();
  }
);

it("retires a pending stream activation and old notifications on replacement", async () => {
  let complete!: (value: Uint8Array) => void;
  const previous = model();
  previous.streamPending = new Promise((resolve) => {
    complete = resolve;
  });
  const { rerender } = render(view(previous));
  await ready();
  const oldNotification = previous.callbacks.get(1)!;
  const current = model();
  rerender(view(current));
  await ready();
  await start();
  expect(streamRequests(previous).filter((r) => r.disableStream)).toHaveLength(
    1
  );
  await act(async () => {
    complete(acknowledgement());
    oldNotification({
      payload: Notification.encode(
        Notification.create({ keyEvent: { position: 0, pressed: true } })
      ).finish(),
    });
    await flush();
  });
  expect(screen.getByTestId("keycap-0")).not.toHaveAttribute(
    "data-state",
    "pressed"
  );
  expect(screen.getByText(/0 \/ 2 seen/)).toBeInTheDocument();
});

it("ignores a retired baseline after connecting another keyboard", async () => {
  let complete!: (value: StatsByPosition) => void;
  const previous = model();
  const { rerender } = render(view(previous));
  await ready();
  previous.statsPending = new Promise((resolve) => {
    complete = resolve;
  });
  fireEvent.click(screen.getByText("Start test"));
  const current = model();
  rerender(view(current));
  await ready();
  await start();
  await act(async () => {
    complete(makeStatsMap([{ position: 0, presses: 9 }]));
    await flush();
  });
  expect(
    within(screen.getByTestId("stats-row-0")).getAllByRole("cell")[1]
  ).toHaveTextContent("0");
  expect(screen.getByText(/0 \/ 2 seen/)).toBeInTheDocument();
});

it("can reload an initially failed topology without reconnecting", async () => {
  const current = model(false);
  current.topologyFailure = true;
  render(view(current));
  await act(flush);
  expect(screen.queryByText("Start test")).not.toBeInTheDocument();
  expect(screen.getByText(/Synthetic topology failure/)).toBeInTheDocument();
  current.topologyFailure = false;
  await act(async () => {
    fireEvent.click(screen.getByText("Reload diagnostics"));
    await flush();
  });
  expect(screen.getByText("Start test")).toBeInTheDocument();
});

it("retires the wizard snapshot when topology is reloaded", async () => {
  const current = model();
  render(view(current));
  await ready();
  await start();
  await key(current, 0, true);
  await key(current, 0, false);
  expect(screen.getByText(/1 \/ 2 seen/)).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByText("Reload diagnostics"));
    await flush();
  });
  expect(screen.getByText("Start test")).toBeInTheDocument();
  expect(screen.queryByText(/Coverage pass/)).not.toBeInTheDocument();
});

it("does not reactivate after page exit while activation is pending", async () => {
  let complete!: (value: Uint8Array) => void;
  const current = model();
  current.streamPending = new Promise((resolve) => {
    complete = resolve;
  });
  render(view(current));
  await ready();
  await act(async () => {
    fireEvent(window, new Event("beforeunload"));
    await flush();
  });
  expect(screen.getByText("Enable live view")).toBeEnabled();
  await act(async () => {
    complete(acknowledgement());
    await flush();
  });
  expect(screen.getByText("Enable live view")).toBeEnabled();
  expect(
    streamRequests(current).filter((request) => request.disableStream)
  ).toHaveLength(1);
});

it("retires a zero-baseline test when this page resets counters", async () => {
  const current = model();
  render(view(current));
  await ready();
  await start();
  current.stats.get(0)!.presses = 1;
  await key(current, 0, true);
  await key(current, 0, false);
  expect(screen.getByText(/1 \/ 2 seen/)).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reset counters" }));
    await flush();
  });
  expect(current.stats.get(0)!.presses).toBe(0);
  expect(screen.getByText("Start test")).toBeEnabled();
  expect(screen.queryByText(/Coverage pass/)).not.toBeInTheDocument();
  expect(screen.getByTestId("keycap-0")).not.toHaveAttribute(
    "data-state",
    "ok"
  );
  await start();
  expect(screen.getByText(/0 \/ 2 seen/)).toBeInTheDocument();
});

it("waits for a pending counter reset before offering a fresh test", async () => {
  let complete!: () => void;
  const current = model();
  current.resetPending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  render(view(current));
  await ready();
  await start();
  await key(current, 0, true);
  await key(current, 0, false);

  fireEvent.click(screen.getByRole("button", { name: "Reset counters" }));
  expect(screen.getByRole("status")).toHaveTextContent("Resetting counters");
  expect(screen.queryByText("Start test")).not.toBeInTheDocument();
  expect(screen.queryByText(/Coverage pass/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reset counters" })).toBeDisabled();
  expect(screen.getByTestId("keycap-0")).not.toHaveAttribute(
    "data-state",
    "ok"
  );
  await act(async () => {
    complete();
    await flush();
  });
  expect(screen.getByText("Start test")).toBeEnabled();
  await start();
  expect(screen.getByText(/0 \/ 2 seen/)).toBeInTheDocument();
});

it("keeps the old test retired if the post-reset statistics refresh fails", async () => {
  const current = model();
  render(view(current));
  await ready();
  await start();
  current.stats.get(0)!.presses = 1;
  await key(current, 0, true);
  await key(current, 0, false);
  current.statsMode = "error";

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reset counters" }));
    await flush();
  });
  expect(current.stats.get(0)!.presses).toBe(0);
  expect(screen.getByText(/Synthetic statistics failure/)).toBeInTheDocument();
  expect(screen.getByText("Start test")).toBeEnabled();
  expect(screen.queryByText(/Coverage pass/)).not.toBeInTheDocument();
  expect(screen.getByTestId("keycap-0")).not.toHaveAttribute(
    "data-state",
    "ok"
  );
  current.statsMode = "ok";
  await start();
  expect(screen.getByText(/0 \/ 2 seen/)).toBeInTheDocument();
});

it("retires the old test even when a counter reset fails", async () => {
  const current = model();
  current.resetFailure = true;
  render(view(current));
  await ready();
  await start();
  current.stats.get(0)!.presses = 1;
  await key(current, 0, true);
  await key(current, 0, false);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reset counters" }));
    await flush();
  });
  expect(current.stats.get(0)!.presses).toBe(1);
  expect(screen.getByText(/Synthetic reset failure/)).toBeInTheDocument();
  expect(screen.getByText("Start test")).toBeEnabled();
  expect(screen.queryByText(/Coverage pass/)).not.toBeInTheDocument();
  expect(screen.getByTestId("keycap-0")).not.toHaveAttribute(
    "data-state",
    "ok"
  );
  await start();
  expect(screen.getByText(/0 \/ 2 seen/)).toBeInTheDocument();
});

it("retires live state and the wizard on core lock, without resuming on unlock", async () => {
  const current = model();
  render(view(current));
  await ready();
  await start();
  await key(current, 0, true);
  await lock(current, true);
  expect(screen.getByTestId("keycap-0")).not.toHaveAttribute(
    "data-state",
    "pressed"
  );
  expect(screen.getByText("Start test")).toBeInTheDocument();
  expect(screen.getByText("Enable live view")).toBeInTheDocument();
  await lock(current, false);
  expect(
    streamRequests(current).filter((request) => request.enableStream)
  ).toHaveLength(1);
  await act(async () => {
    fireEvent.click(screen.getByText("Enable live view"));
    await flush();
  });
  expect(
    streamRequests(current).filter((request) => request.enableStream)
  ).toHaveLength(2);
  expect(screen.queryByText("Enable live view")).not.toBeInTheDocument();
});

it("rejects an activation acknowledgement arriving after lock and unlock", async () => {
  const current = model();
  let complete!: (bytes: Uint8Array) => void;
  current.streamPending = new Promise((resolve) => {
    complete = resolve;
  });
  render(view(current));
  await ready();
  await lock(current, true);
  await lock(current, false);
  await act(async () => {
    complete(acknowledgement());
    await flush();
  });
  expect(screen.getByText("Enable live view")).toBeInTheDocument();
  await key(current, 0, true);
  expect(screen.getByTestId("keycap-0")).not.toHaveAttribute(
    "data-state",
    "pressed"
  );
});

it.each(["baseline", "final"])(
  "rejects a pending %s statistics result after a core lock",
  async (stage) => {
    const current = model();
    render(view(current));
    await ready();
    if (stage === "final") {
      await start();
      fireEvent.click(screen.getByText(/Done pressing/));
    }
    let complete!: (stats: StatsByPosition) => void;
    current.statsPending = new Promise((resolve) => {
      complete = resolve;
    });
    if (stage === "baseline") await start();
    else
      await act(async () => {
        fireEvent.click(screen.getByText(/Done retesting/));
        await flush();
      });
    await lock(current, true);
    await lock(current, false);
    await act(async () => {
      complete(
        new Map(
          [...current.stats].map(([position, stats]) => [
            position,
            { ...stats, presses: 123 },
          ])
        )
      );
      await flush();
    });
    expect(screen.getByText("Start test")).toBeInTheDocument();
    expect(
      screen.queryByText(/Coverage pass|Chatter check/)
    ).not.toBeInTheDocument();
    expect(screen.queryByText("123")).not.toBeInTheDocument();
  }
);

it("renews the confirmed input-stream epoch and retires a late renewal on lock", async () => {
  const current = model();
  current.leaseEpoch = 41;
  render(view(current));
  await ready();
  let complete!: (bytes: Uint8Array) => void;
  current.streamPending = new Promise((resolve) => {
    complete = resolve;
  });
  await act(async () => {
    jest.advanceTimersByTime(2000);
    await flush();
  });
  expect(streamRequests(current)[1].enableStream).toEqual({
    renewOnly: true,
    streamEpoch: 41,
  });
  await lock(current, true);
  await lock(current, false);
  await act(async () => {
    complete(
      StreamResponse.encode(
        StreamResponse.create({ ok: { streamEpoch: 41, leaseMs: 15000 } })
      ).finish()
    );
    jest.advanceTimersByTime(20000);
    await flush();
  });
  expect(streamRequests(current)).toHaveLength(2);
  expect(screen.getByText("Enable live view")).toBeInTheDocument();
});
