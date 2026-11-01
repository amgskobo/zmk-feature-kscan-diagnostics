import {
  buildCellWiring,
  buildWiringMap,
  GpioLineKind,
  KscanDriverType,
} from "../src/kscanDiagnosticsTypes";
import type { KscanLayout, Topology } from "../src/kscanDiagnosticsTypes";

const layout: KscanLayout = {
  layoutIndex: 0,
  displayName: "Synthetic direct layout",
  rows: 1,
  columns: 3,
  keyCount: 3,
  deviceIndices: [{ leafIndex: 0, rowOffset: 0, colOffset: 0 }],
  positionMap: [0, 1, 2],
};
const topology: Topology = {
  protoVersion: 1,
  selectedLayout: 0,
  statsEnabled: true,
  maxPositions: 3,
  uptimeMs: 0,
  layouts: [layout],
  devices: [
    {
      deviceIndex: 0,
      nodeName: "synthetic-direct",
      type: KscanDriverType.DIRECT,
      rows: 1,
      columns: 3,
      inputs: 3,
      debouncePressMs: 5,
      debounceReleaseMs: 5,
      debounceScanPeriodMs: 1,
      pollPeriodMs: 1,
      diodeRow2col: false,
      toggleMode: false,
      gpioLinesByKind: {
        [GpioLineKind.KIND_UNKNOWN]: [],
        [GpioLineKind.ROW]: [],
        [GpioLineKind.COL]: [],
        [GpioLineKind.INPUT]: [10, 11, 12].map((pin, index) => ({
          index,
          port: "gpio0",
          pin,
          activeLow: true,
          dtFlags: 0,
        })),
        [GpioLineKind.OUTPUT]: [],
        [GpioLineKind.CHARLIE]: [],
      },
    },
  ],
};

it("resolves each direct input in both the view and diagnosis wiring", () => {
  expect(
    [...buildWiringMap(topology, layout).values()].map((v) => v.rowLine?.pin)
  ).toEqual([10, 11, 12]);
  expect(buildCellWiring(topology, layout).map((v) => v.rowLine?.pin)).toEqual([
    10, 11, 12,
  ]);
});

it("subtracts composite offsets before resolving direct inputs", () => {
  const offsetLayout = {
    ...layout,
    rows: 2,
    columns: 5,
    deviceIndices: [{ leafIndex: 0, rowOffset: 1, colOffset: 2 }],
    positionMap: [null, null, null, null, null, null, null, 0, 1, 2],
  };
  expect(
    [...buildWiringMap(topology, offsetLayout).values()].map(
      (v) => v.rowLine?.pin
    )
  ).toEqual([10, 11, 12]);
});

it("does not label a demux address bit as a decoded column wire", () => {
  const demuxLayout = {
    ...layout,
    rows: 2,
    columns: 4,
    keyCount: 8,
    positionMap: Array.from({ length: 8 }, (_, i) => i),
  };
  const demux = {
    ...topology,
    layouts: [demuxLayout],
    devices: [
      {
        ...topology.devices[0],
        type: KscanDriverType.DEMUX,
        rows: 2,
        columns: 4,
        inputs: 2,
        gpioLinesByKind: {
          ...topology.devices[0].gpioLinesByKind,
          [GpioLineKind.OUTPUT]: [20, 21].map((pin, index) => ({
            index,
            port: "gpio0",
            pin,
            activeLow: false,
            dtFlags: 0,
          })),
        },
      },
    ],
  };
  const wires = [...buildWiringMap(demux, demuxLayout).values()];
  expect(wires.map((value) => value.rowLine?.pin)).toEqual([
    10, 10, 10, 10, 11, 11, 11, 11,
  ]);
  expect(wires.map((value) => value.colLine)).toEqual(Array(8).fill(null));
});
