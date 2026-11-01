import { diagnose } from "../../src/diagnosis/engine";
import { KscanDriverType } from "../../src/kscanDiagnosticsTypes";
import type { CellWiring } from "../../src/diagnosis/types";
import { makeStatsMap } from "./fixtures";

function cells(stacked: boolean): CellWiring[] {
  return Array.from({ length: 8 }, (_, position) => {
    const row = Math.floor(position / (stacked ? 2 : 4));
    const column = position % (stacked ? 2 : 4);
    const device = stacked ? Math.floor(row / 2) : Math.floor(column / 2);
    const pin = (value: number) => ({
      index: value,
      port: "gpio0",
      pin: value,
      activeLow: true,
      dtFlags: 0,
    });
    return {
      position,
      row,
      column,
      deviceType: KscanDriverType.MATRIX,
      rowLine: pin(device * 2 + (stacked ? row % 2 : row)),
      colLine: pin(10 + device * 2 + (column % 2)),
    };
  });
}
function findings(layout: CellWiring[], dead: number[]) {
  return diagnose({
    cells: layout,
    coverage: layout.map((cell) => ({
      position: cell.position,
      status: dead.includes(cell.position) ? "missed" : "seen",
      pressCount: dead.includes(cell.position) ? 0 : 1,
    })),
    statsAfter: makeStatsMap(),
    eventLog: [],
    chatterBucket: "lt50",
  });
}

it("separates independent physical row lines at the same logical row", () => {
  const rows = findings(cells(false), [0, 1, 2, 3]).filter(
    (f) => f.kind === "ROW_FAULT"
  );
  expect(rows.map((f) => f.positions)).toEqual([
    [0, 1],
    [2, 3],
  ]);
  expect(rows[0].action).toContain("gpio0 pin 0");
  expect(rows[1].action).toContain("gpio0 pin 2");
});

it("does not use another device's logical column as electrical proof", () => {
  expect(
    findings(cells(true), [0, 1, 2, 3]).filter((f) =>
      ["ROW_FAULT", "COLUMN_FAULT", "KEY_FAULT"].includes(f.kind)
    )
  ).toEqual([]);
});
