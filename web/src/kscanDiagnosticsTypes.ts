/**
 * Assembled, UI-friendly view over the cormoran__kscan_diagnostics custom RPC
 * subsystem (DESIGN.md §6-7). The raw generated messages
 * (`./proto/cormoran/kscan_diagnostics/kscan_diagnostics`) are paged and
 * fragmented on the wire; `useKscanDiagnostics` sequences the paging and
 * assembles the shapes below for the rest of the app to consume.
 */
import {
  GpioLineKind,
  KscanDriverType,
} from "./proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import type { GpioPin } from "./proto/cormoran/kscan_diagnostics/kscan_diagnostics";

export interface KscanDevice {
  deviceIndex: number;
  nodeName: string;
  type: KscanDriverType;
  rows: number;
  columns: number;
  inputs: number;
  debouncePressMs: number;
  debounceReleaseMs: number;
  debounceScanPeriodMs: number;
  pollPeriodMs: number;
  diodeRow2col: boolean;
  toggleMode: boolean;
  /**
   * GPIO lines grouped by kind (GetGpioPins' `kind` request field is the
   * only place kind is known — the GpioPin response message itself carries
   * no kind field — so `useKscanDiagnostics` issues one paged fetch per
   * kind and keeps them separated here).
   */
  gpioLinesByKind: Record<GpioLineKind, GpioPin[]>;
}

export interface KscanLayoutDevice {
  leafIndex: number;
  rowOffset: number;
  colOffset: number;
}

export interface KscanLayout {
  layoutIndex: number;
  displayName: string;
  rows: number;
  columns: number;
  keyCount: number;
  deviceIndices: KscanLayoutDevice[];
  /**
   * Row-major over rows x columns; value is a zero-based keymap position, or
   * `null` when the (row, column) cell has no transform entry (unmapped —
   * DESIGN.md §1 known limitation 4: ghost presses on unmapped cells are
   * invisible).
   */
  positionMap: (number | null)[];
}

export interface Topology {
  protoVersion: number;
  selectedLayout: number;
  statsEnabled: boolean;
  maxPositions: number;
  uptimeMs: number;
  devices: KscanDevice[];
  layouts: KscanLayout[];
}

/** Resolve which device+line drives the row and column of a keyboard position. */
export interface PositionWiring {
  position: number;
  row: number;
  column: number;
  device: KscanDevice | null;
  layoutDevice: KscanLayoutDevice | null;
  /** GPIO line for this cell's row (matrix/charlieplex) — null for direct/demux without a row concept. */
  rowLine: GpioPin | null;
  /** GPIO line for this cell's column. */
  colLine: GpioPin | null;
}

export { GpioLineKind, KscanDriverType };

export interface PositionStatsEntry {
  position: number;
  presses: number;
  releases: number;
  minPressDurationMs: number;
  minRepressGapMs: number;
  repressLt5: number;
  repressLt10: number;
  repressLt20: number;
  repressLt50: number;
  lastSource: number;
}

export type StatsByPosition = Map<number, PositionStatsEntry>;

/** Diagnosis-engine-shaped wiring for one (row, col) cell — see diagnosis/types.ts's CellWiring. */
export interface CellWiring {
  position: number;
  row: number;
  column: number;
  deviceType: KscanDriverType;
  rowLine: GpioPin | null;
  colLine: GpioPin | null;
}

/** Build the DiagnosisEngine's `CellWiring[]` input for every mapped position of a layout. */
export function buildCellWiring(
  topology: Topology,
  layout: KscanLayout
): CellWiring[] {
  const cells: CellWiring[] = [];
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.columns; col++) {
      const cellIndex = row * layout.columns + col;
      const position = layout.positionMap[cellIndex];
      if (position === null || position === undefined) continue;
      const resolved = resolveDeviceForCell(topology, layout, row, col);
      if (!resolved) {
        cells.push({
          position,
          row,
          column: col,
          deviceType: KscanDriverType.UNKNOWN,
          rowLine: null,
          colLine: null,
        });
        continue;
      }
      const { device, localRow, localCol } = resolved;
      const { rowLine, colLine } = resolveRowColLines(
        device,
        localRow,
        localCol
      );
      cells.push({
        position,
        row,
        column: col,
        deviceType: device.type,
        rowLine,
        colLine,
      });
    }
  }
  return cells;
}

/**
 * Resolve which leaf device backs a (row, column) cell of a layout, and the
 * cell's coordinates in that device's own local (row, column) space.
 *
 * Composite kscans (DESIGN.md §4) combine multiple leaf devices with a
 * row/col offset each; a cell belongs to the first device whose local range
 * (after subtracting its offset) contains the cell.
 */
export function resolveDeviceForCell(
  topology: Topology,
  layout: KscanLayout,
  row: number,
  column: number
): {
  device: KscanDevice;
  layoutDevice: KscanLayoutDevice;
  localRow: number;
  localCol: number;
} | null {
  for (const ld of layout.deviceIndices) {
    const device = topology.devices.find((d) => d.deviceIndex === ld.leafIndex);
    if (!device) continue;
    const localRow = row - ld.rowOffset;
    const localCol = column - ld.colOffset;
    if (
      localRow >= 0 &&
      localRow < device.rows &&
      localCol >= 0 &&
      localCol < device.columns
    ) {
      return { device, layoutDevice: ld, localRow, localCol };
    }
  }
  return null;
}

/**
 * Resolve the GPIO line driving one cell's row and column. Charlieplex has
 * no separate row/col address space (the same physical lines serve both,
 * DESIGN.md §4), so its ROW-kind and COL-kind pages both index into the
 * shared `gpios` line list. Direct/demux have no "row" concept; the input
 * line is surfaced as `rowLine` so the UI still shows one wire per key.
 * Demux columns are binary addresses over several OUTPUT lines, not indices
 * into that list; there is no single physical column GPIO to display.
 */
export function resolveRowColLines(
  device: KscanDevice,
  localRow: number,
  localCol: number
): { rowLine: GpioPin | null; colLine: GpioPin | null } {
  switch (device.type) {
    case KscanDriverType.MATRIX:
      return {
        rowLine: device.gpioLinesByKind[GpioLineKind.ROW]?.[localRow] ?? null,
        colLine: device.gpioLinesByKind[GpioLineKind.COL]?.[localCol] ?? null,
      };
    case KscanDriverType.CHARLIEPLEX:
      return {
        rowLine:
          device.gpioLinesByKind[GpioLineKind.CHARLIE]?.[localRow] ?? null,
        colLine:
          device.gpioLinesByKind[GpioLineKind.CHARLIE]?.[localCol] ?? null,
      };
    case KscanDriverType.DIRECT:
      return {
        rowLine: device.gpioLinesByKind[GpioLineKind.INPUT]?.[localCol] ?? null,
        colLine: null,
      };
    case KscanDriverType.DEMUX:
      return {
        rowLine: device.gpioLinesByKind[GpioLineKind.INPUT]?.[localRow] ?? null,
        colLine: null,
      };
    default:
      return { rowLine: null, colLine: null };
  }
}

/** Per-position wiring summary used by KeyboardView's hover/wiring-mode UI. */
export interface KeyWiringInfo {
  position: number;
  row: number;
  column: number;
  device: KscanDevice | null;
  rowLine: { port: string; pin: number } | null;
  colLine: { port: string; pin: number } | null;
}

/** Resolve wiring info for every mapped position of a layout, keyed by position. */
export function buildWiringMap(
  topology: Topology,
  layout: KscanLayout
): Map<number, KeyWiringInfo> {
  const map = new Map<number, KeyWiringInfo>();
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.columns; col++) {
      const cellIndex = row * layout.columns + col;
      const position = layout.positionMap[cellIndex];
      if (position === null || position === undefined) continue;
      const resolved = resolveDeviceForCell(topology, layout, row, col);
      if (!resolved) {
        map.set(position, {
          position,
          row,
          column: col,
          device: null,
          rowLine: null,
          colLine: null,
        });
        continue;
      }
      const { device, localRow, localCol } = resolved;
      const { rowLine, colLine } = resolveRowColLines(
        device,
        localRow,
        localCol
      );
      map.set(position, {
        position,
        row,
        column: col,
        device,
        rowLine: rowLine ? { port: rowLine.port, pin: rowLine.pin } : null,
        colLine: colLine ? { port: colLine.port, pin: colLine.pin } : null,
      });
    }
  }
  return map;
}
