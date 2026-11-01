/**
 * Data hook for this module's custom RPC subsystem
 * (`cormoran__kscan_diagnostics`, DESIGN.md §6-7).
 *
 * Sequences GetInfo -> GetLayout(s) -> GetDevice(s) -> paged
 * GetGpioPins/GetPositionMap into one assembled `Topology` object, and
 * exposes `getStats` (paged) / `resetStats`.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ZMKAppContext,
  ZMKCustomSubsystem,
} from "@cormoran/zmk-studio-react-hook";
import {
  GpioLineKind,
  Request,
  Response,
} from "./proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import type { GpioPin } from "./proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import type {
  KscanDevice,
  KscanLayout,
  PositionStatsEntry,
  StatsByPosition,
  Topology,
} from "./kscanDiagnosticsTypes";

export const SUBSYSTEM_IDENTIFIER = "cormoran__kscan_diagnostics";

/**
 * Paging sizes are enforced firmware-side
 * (src/studio/kscan_diagnostics_handler.c's KSCAN_DIAGNOSTICS_RPC_*_PAGE_SIZE);
 * this hook just follows the `offset`/`total` fields the firmware returns
 * and doesn't need to know the page size itself.
 */
/** Safety valve so a misbehaving firmware (total never reached, or offset
 * never advances) cannot hang the UI in an infinite paging loop. */
const MAX_PAGES = 2000;

class KscanDiagnosticsRpcError extends Error {}

function nextPageOffset(
  expected: number,
  offset: number,
  count: number,
  total: number
): number {
  if (
    offset !== expected ||
    offset > total ||
    count > total - offset ||
    (count === 0 && offset < total)
  )
    throw new KscanDiagnosticsRpcError(
      "Incomplete or out-of-order response page"
    );
  return offset + count;
}

async function callRpc(
  service: ZMKCustomSubsystem,
  request: Request
): Promise<Response> {
  const payload = Request.encode(request).finish();
  const respPayload = await service.callRPC(payload);
  if (!respPayload) {
    throw new KscanDiagnosticsRpcError("No response from device");
  }
  const resp = Response.decode(respPayload);
  if (resp.error) {
    throw new KscanDiagnosticsRpcError(resp.error.message);
  }
  return resp;
}

async function fetchGpioPinsOfKind(
  service: ZMKCustomSubsystem,
  deviceIndex: number,
  kind: GpioLineKind
): Promise<GpioPin[]> {
  const pins: GpioPin[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await callRpc(service, {
      getGpioPins: { deviceIndex, kind, offset },
    });
    const chunk = resp.gpioPins;
    if (!chunk)
      throw new KscanDiagnosticsRpcError("Unexpected response to GetGpioPins");
    pins.push(...chunk.pins);
    offset = nextPageOffset(
      offset,
      chunk.offset,
      chunk.pins.length,
      chunk.total
    );
    if (offset >= chunk.total) return pins;
  }
  throw new KscanDiagnosticsRpcError("GPIO page limit exceeded");
}

/**
 * GpioPin (the response message) carries no kind field — kind is only a
 * GetGpioPins request-side filter (proto/.../kscan_diagnostics.proto) — so
 * fetch one paged sequence per kind to keep them separated for
 * `resolveRowColLines`. KIND_UNKNOWN is skipped: it means "unfiltered" on
 * the wire, which would duplicate lines already fetched per-kind.
 */
async function fetchGpioLinesByKind(
  service: ZMKCustomSubsystem,
  deviceIndex: number
): Promise<Record<GpioLineKind, GpioPin[]>> {
  const kinds: GpioLineKind[] = [
    GpioLineKind.ROW,
    GpioLineKind.COL,
    GpioLineKind.INPUT,
    GpioLineKind.OUTPUT,
    GpioLineKind.CHARLIE,
  ];
  const result = {} as Record<GpioLineKind, GpioPin[]>;
  result[GpioLineKind.KIND_UNKNOWN] = [];
  for (const kind of kinds) {
    result[kind] = await fetchGpioPinsOfKind(service, deviceIndex, kind);
  }
  return result;
}

async function fetchPositionMap(
  service: ZMKCustomSubsystem,
  layoutIndex: number
): Promise<(number | null)[]> {
  const cells: (number | null)[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await callRpc(service, {
      getPositionMap: { layoutIndex, offset },
    });
    const chunk = resp.positionMap;
    if (!chunk)
      throw new KscanDiagnosticsRpcError(
        "Unexpected response to GetPositionMap"
      );
    for (const cell of chunk.cells) {
      // 0 = unmapped, otherwise position+1 (DESIGN.md §6).
      cells.push(cell === 0 ? null : cell - 1);
    }
    offset = nextPageOffset(
      offset,
      chunk.offset,
      chunk.cells.length,
      chunk.total
    );
    if (offset >= chunk.total) return cells;
  }
  throw new KscanDiagnosticsRpcError("Position-map page limit exceeded");
}

async function fetchDevice(
  service: ZMKCustomSubsystem,
  deviceIndex: number
): Promise<KscanDevice> {
  const resp = await callRpc(service, { getDevice: { deviceIndex } });
  const d = resp.device;
  if (!d)
    throw new KscanDiagnosticsRpcError("Unexpected response to GetDevice");
  const gpioLinesByKind = await fetchGpioLinesByKind(service, deviceIndex);
  return {
    deviceIndex: d.deviceIndex,
    nodeName: d.nodeName,
    type: d.type,
    rows: d.rows,
    columns: d.columns,
    inputs: d.inputs,
    debouncePressMs: d.debouncePressMs,
    debounceReleaseMs: d.debounceReleaseMs,
    debounceScanPeriodMs: d.debounceScanPeriodMs,
    pollPeriodMs: d.pollPeriodMs,
    diodeRow2col: d.diodeRow2col,
    toggleMode: d.toggleMode,
    gpioLinesByKind,
  };
}

async function fetchLayout(
  service: ZMKCustomSubsystem,
  layoutIndex: number
): Promise<KscanLayout> {
  const resp = await callRpc(service, { getLayout: { layoutIndex } });
  const l = resp.layout;
  if (!l)
    throw new KscanDiagnosticsRpcError("Unexpected response to GetLayout");
  const positionMap = await fetchPositionMap(service, layoutIndex);
  return {
    layoutIndex: l.layoutIndex,
    displayName: l.displayName,
    rows: l.rows,
    columns: l.columns,
    keyCount: l.keyCount,
    deviceIndices: l.deviceIndices.map((d) => ({
      leafIndex: d.leafIndex,
      rowOffset: d.rowOffset,
      colOffset: d.colOffset,
    })),
    positionMap,
  };
}

async function fetchTopology(service: ZMKCustomSubsystem): Promise<Topology> {
  const infoResp = await callRpc(service, { getInfo: {} });
  const info = infoResp.info;
  if (!info)
    throw new KscanDiagnosticsRpcError("Unexpected response to GetInfo");

  const layouts: KscanLayout[] = [];
  for (let i = 0; i < info.layoutCount; i++) {
    layouts.push(await fetchLayout(service, i));
  }

  // Discover the set of device indices actually referenced by layouts; every
  // device in device_count is still fetched so the wiring overlay works even
  // for devices not attached to the active layout (multi-layout keyboards).
  const devices: KscanDevice[] = [];
  for (let i = 0; i < info.deviceCount; i++) {
    devices.push(await fetchDevice(service, i));
  }

  return {
    protoVersion: info.protoVersion,
    selectedLayout: info.selectedLayout,
    statsEnabled: info.statsEnabled,
    maxPositions: info.maxPositions,
    uptimeMs: info.uptimeMs,
    devices,
    layouts,
  };
}

async function fetchStats(
  service: ZMKCustomSubsystem
): Promise<StatsByPosition> {
  const byPosition: StatsByPosition = new Map();
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await callRpc(service, { getStats: { offset } });
    const chunk = resp.stats;
    if (!chunk)
      throw new KscanDiagnosticsRpcError("Unexpected response to GetStats");
    for (const e of chunk.entries) {
      const entry: PositionStatsEntry = {
        position: e.position,
        presses: e.presses,
        releases: e.releases,
        minPressDurationMs: e.minPressDurationMs,
        minRepressGapMs: e.minRepressGapMs,
        repressLt5: e.repressLt5,
        repressLt10: e.repressLt10,
        repressLt20: e.repressLt20,
        repressLt50: e.repressLt50,
        lastSource: e.lastSource,
      };
      byPosition.set(entry.position, entry);
    }
    offset = nextPageOffset(
      offset,
      chunk.offset,
      chunk.entries.length,
      chunk.total
    );
    if (offset >= chunk.total) return byPosition;
  }
  throw new KscanDiagnosticsRpcError("Statistics page limit exceeded");
}

export interface UseKscanDiagnosticsReturn {
  /** Whether the `cormoran__kscan_diagnostics` subsystem was found on the device. */
  available: boolean;
  topology: Topology | null;
  stats: StatsByPosition | null;
  isLoading: boolean;
  error: string | null;
  /** (Re-)fetch the full topology. */
  loadTopology: () => Promise<void>;
  /**
   * (Re-)fetch stats for every position; also returns the freshly-fetched
   * map directly so callers (e.g. TestWizard's baseline/after snapshots)
   * don't have to read back through `stats` state, which may still hold the
   * previous value in the same render/closure.
   */
  loadStats: () => Promise<StatsByPosition>;
  /** Reset all firmware-side counters, then re-fetch stats. */
  resetStats: () => Promise<void>;
}

export function useKscanDiagnostics(): UseKscanDiagnosticsReturn {
  const zmkApp = useContext(ZMKAppContext);
  const connection = zmkApp?.state.connection ?? null;
  const subsystemIndex = zmkApp?.findSubsystem(SUBSYSTEM_IDENTIFIER)?.index;
  const service = useMemo(() => {
    if (!connection || subsystemIndex === undefined) return null;
    return new ZMKCustomSubsystem(connection, subsystemIndex);
  }, [connection, subsystemIndex]);
  const scopeRef = useRef({
    service,
    active: true,
    topologyRequest: 0,
    statsRequest: 0,
  });
  useEffect(() => {
    const scope = scopeRef.current;
    scope.service = service;
    scope.active = true;
    return () => {
      scope.active = false;
      scope.topologyRequest++;
      scope.statsRequest++;
    };
  }, [service]);

  const [topology, setTopology] = useState<Topology | null>(null);
  const [stats, setStats] = useState<StatsByPosition | null>(null);
  const [topologyLoading, setTopologyLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  const loadTopology = useCallback(async () => {
    const scope = scopeRef.current;
    if (!service || !scope.active || scope.service !== service) return;
    const ticket = ++scope.topologyRequest;
    const owns = () =>
      scope.active &&
      scope.service === service &&
      scope.topologyRequest === ticket;
    setTopologyLoading(true);
    setTopologyError(null);
    try {
      const result = await fetchTopology(service);
      if (owns()) setTopology(result);
    } catch (failure) {
      if (owns())
        setTopologyError(
          failure instanceof Error ? failure.message : "Unknown error"
        );
    } finally {
      if (owns()) setTopologyLoading(false);
    }
  }, [service]);

  const loadStats = useCallback(async () => {
    const scope = scopeRef.current;
    if (!service || !scope.active || scope.service !== service)
      throw new KscanDiagnosticsRpcError("Diagnostics connection unavailable");
    const ticket = ++scope.statsRequest;
    const owns = () =>
      scope.active &&
      scope.service === service &&
      scope.statsRequest === ticket;
    setStatsLoading(true);
    setStatsError(null);
    try {
      const result = await fetchStats(service);
      if (owns()) setStats(result);
      return result;
    } catch (failure) {
      if (owns())
        setStatsError(
          failure instanceof Error ? failure.message : "Unknown error"
        );
      // A wizard must not treat a failed read as an empty, successful baseline.
      throw failure;
    } finally {
      if (owns()) setStatsLoading(false);
    }
  }, [service]);

  const resetStats = useCallback(async () => {
    const scope = scopeRef.current;
    if (!service || !scope.active || scope.service !== service) return;
    const ticket = ++scope.statsRequest;
    const owns = () =>
      scope.active &&
      scope.service === service &&
      scope.statsRequest === ticket;
    setStatsLoading(true);
    setStatsError(null);
    try {
      const response = await callRpc(service, { resetStats: {} });
      if (!owns()) return;
      if (!response.ok)
        throw new KscanDiagnosticsRpcError("Missing reset acknowledgement");
      await loadStats();
    } catch (failure) {
      if (owns())
        setStatsError(
          failure instanceof Error ? failure.message : "Unknown error"
        );
      throw failure;
    } finally {
      if (owns()) setStatsLoading(false);
    }
  }, [service, loadStats]);

  return {
    available: service !== null,
    topology,
    stats,
    isLoading: topologyLoading || statsLoading,
    error: topologyError ?? statsError,
    loadTopology,
    loadStats,
    resetStats,
  };
}
