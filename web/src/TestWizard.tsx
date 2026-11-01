/**
 * Test wizard state machine (DESIGN.md §7 screen 3): coverage pass, retest
 * pass for missed keys, chatter check, and a report screen driven by the
 * DiagnosisEngine.
 *
 * Live coverage tracking uses `useInputStream` events when available;
 * otherwise it falls back to polling `GetStats` at ~2 Hz and diffing press
 * counts against the snapshot taken when the pass started (DESIGN.md §7).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diagnose } from "./diagnosis/engine";
import type {
  CellWiring,
  DiagnosisKeyEvent,
  Finding,
  PositionCoverage,
} from "./diagnosis/types";
import type { StatsByPosition } from "./kscanDiagnosticsTypes";

export type WizardPhase = "idle" | "coverage" | "retest" | "chatter" | "report";

export type ChatterBucket = "lt5" | "lt10" | "lt20" | "lt50";

export interface TestWizardProps {
  /** All cells (positions) of the layout under test, with resolved wiring. */
  cells: CellWiring[];
  /** Fetch a fresh stats snapshot on demand (from useKscanDiagnostics). */
  fetchStats: () => Promise<StatsByPosition>;
  /** Live input-stream event log, if available (empty array when not). */
  liveEvents: DiagnosisKeyEvent[];
  /** Whether live input-stream events are usable right now. */
  liveAvailable: boolean;
  /** Called whenever the wizard wants the current coverage map, for KeyboardView highlighting. */
  onCoverageChange?: (coverage: Map<number, PositionCoverage>) => void;
}

const POLL_INTERVAL_MS = 500;
const COUNTERS = [
  "presses",
  "releases",
  "repressLt5",
  "repressLt10",
  "repressLt20",
  "repressLt50",
] as const;

class SessionCountersError extends Error {}

function assertNotSaturated(
  snapshot: StatsByPosition,
  positions: readonly number[]
) {
  for (const position of positions) {
    const entry = snapshot.get(position);
    if (entry && COUNTERS.some((field) => entry[field] >= 0xffff))
      throw new SessionCountersError(
        "Counters are saturated. Reset counters before starting a new test."
      );
  }
}

function assertCounters(current: StatsByPosition, baseline: StatsByPosition) {
  for (const [position, before] of baseline) {
    const after = current.get(position);
    if (!after)
      throw new SessionCountersError(
        "Incomplete statistics. Start a new test."
      );
    if (COUNTERS.some((field) => after[field] < before[field]))
      throw new SessionCountersError(
        "Counters were reset during this test. Start a new test."
      );
  }
}

export function TestWizard({
  cells,
  fetchStats,
  liveEvents,
  liveAvailable,
  onCoverageChange,
}: TestWizardProps) {
  const [phase, setPhase] = useState<WizardPhase>("idle");
  const [coverage, setCoverage] = useState<Map<number, PositionCoverage>>(
    new Map()
  );
  const [statsBaseline, setStatsBaseline] = useState<StatsByPosition | null>(
    null
  );
  const [statsAfter, setStatsAfter] = useState<StatsByPosition | null>(null);
  const [chatterBucket, setChatterBucket] = useState<ChatterBucket>("lt50");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [invalidCounters, setInvalidCounters] = useState(false);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef({ active: true, revision: 0, busy: false });
  const eventsRef = useRef(liveEvents);
  const lastSeenEvent = useRef<DiagnosisKeyEvent | null>(null);

  useEffect(() => {
    const current = lifetime.current;
    current.active = true;
    return () => {
      current.active = false;
      current.revision++;
    };
  }, []);
  useEffect(() => {
    eventsRef.current = liveEvents;
  }, [liveEvents]);

  const positionsUnderTest = useMemo(
    () => cells.map((c) => c.position),
    [cells]
  );

  const initCoverage = useCallback((): Map<number, PositionCoverage> => {
    const map = new Map<number, PositionCoverage>();
    for (const position of positionsUnderTest) {
      map.set(position, { position, status: "untested", pressCount: 0 });
    }
    return map;
  }, [positionsUnderTest]);

  useEffect(() => {
    onCoverageChange?.(coverage);
  }, [coverage, onCoverageChange]);

  // Retained objects are stable even after the 500-entry log stops growing.
  useEffect(() => {
    if (phase !== "coverage" && phase !== "retest") return;
    if (!liveAvailable) return;
    const boundary = lastSeenEvent.current;
    const boundaryIndex = boundary ? liveEvents.indexOf(boundary) : -1;
    const added =
      boundaryIndex >= 0 ? liveEvents.slice(0, boundaryIndex) : liveEvents;
    lastSeenEvent.current = liveEvents[0] ?? null;
    if (added.length === 0) return;
    setCoverage((previous) => {
      const next = new Map(previous);
      for (const event of added) {
        const current = next.get(event.position);
        if (!event.pressed || !current) continue;
        next.set(event.position, {
          ...current,
          status: "seen",
          pressCount: current.pressCount + 1,
        });
      }
      return next;
    });
  }, [liveEvents, liveAvailable, phase]);

  const applyStatsCoverage = useCallback(
    (current: StatsByPosition) => {
      if (!statsBaseline) return;
      assertNotSaturated(current, positionsUnderTest);
      assertCounters(current, statsBaseline);
      setCoverage((previous) => {
        const next = new Map(previous);
        for (const [position, value] of previous) {
          if (!current.has(position) || !statsBaseline.has(position)) continue;
          const count =
            (current.get(position)?.presses ?? 0) -
            (statsBaseline.get(position)?.presses ?? 0);
          // A stream activation can overlap the last statistics page. Use the
          // firmware delta to reconcile counts before making a diagnosis.
          next.set(position, {
            ...value,
            status: count > 0 ? "seen" : value.status,
            pressCount: count,
          });
        }
        return next;
      });
    },
    [statsBaseline, positionsUnderTest]
  );

  useEffect(() => {
    if (liveAvailable || invalidCounters) return;
    if (phase !== "coverage" && phase !== "retest") return;
    if (!statsBaseline) return;
    const current = lifetime.current;
    const ticket = current.revision;
    let cancelled = false;
    let pending = false;
    const owns = () =>
      !cancelled && current.active && current.revision === ticket;
    const id = setInterval(() => {
      if (pending || current.busy || !owns()) return;
      pending = true;
      void (async () => {
        try {
          const snapshot = await fetchStats();
          if (!owns()) return;
          applyStatsCoverage(snapshot);
          setError(null);
        } catch (failure) {
          if (!owns()) return;
          setError(
            failure instanceof Error
              ? failure.message
              : "Statistics read failed"
          );
          if (failure instanceof SessionCountersError) setInvalidCounters(true);
        } finally {
          pending = false;
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    liveAvailable,
    phase,
    statsBaseline,
    fetchStats,
    applyStatsCoverage,
    revision,
    invalidCounters,
  ]);

  const startCoverage = useCallback(async () => {
    const current = lifetime.current;
    if (current.busy) return;
    current.busy = true;
    const ticket = ++current.revision;
    setRevision(ticket);
    setIsBusy(true);
    setError(null);
    const owns = () => current.active && current.revision === ticket;
    try {
      // Chatter always needs a baseline, including when live view is enabled.
      const baseline = await fetchStats();
      if (!owns()) return;
      assertNotSaturated(baseline, positionsUnderTest);
      lastSeenEvent.current = eventsRef.current[0] ?? null;
      setStatsBaseline(baseline);
      setStatsAfter(null);
      setCoverage(initCoverage());
      setFindings([]);
      setInvalidCounters(false);
      setPhase("coverage");
    } catch (failure) {
      if (owns())
        setError(
          failure instanceof Error
            ? failure.message
            : "Failed to fetch baseline statistics"
        );
    } finally {
      if (owns()) {
        current.busy = false;
        setIsBusy(false);
      }
    }
  }, [fetchStats, initCoverage, positionsUnderTest]);

  const missedPositions = useMemo(
    () =>
      [...coverage.values()]
        .filter((c) => c.status !== "seen")
        .map((c) => c.position),
    [coverage]
  );

  const finishCoverage = useCallback(() => {
    setCoverage((previous) => {
      const next = new Map(previous);
      for (const [position, value] of previous) {
        if (value.status === "untested")
          next.set(position, { ...value, status: "missed" });
      }
      return next;
    });
    setPhase("retest");
  }, []);

  const finishRetest = useCallback(async () => {
    const current = lifetime.current;
    if (current.busy || invalidCounters) return;
    current.busy = true;
    const ticket = ++current.revision;
    setRevision(ticket);
    setIsBusy(true);
    setError(null);
    const owns = () => current.active && current.revision === ticket;
    try {
      const after = await fetchStats();
      if (!owns()) return;
      applyStatsCoverage(after);
      setStatsAfter(after);
      setPhase("chatter");
    } catch (failure) {
      if (owns()) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Failed to fetch statistics"
        );
        if (failure instanceof SessionCountersError) setInvalidCounters(true);
      }
    } finally {
      if (owns()) {
        current.busy = false;
        setIsBusy(false);
      }
    }
  }, [fetchStats, applyStatsCoverage, invalidCounters]);

  const runDiagnosis = useCallback(() => {
    if (!statsAfter || !statsBaseline || invalidCounters) return;
    const result = diagnose({
      cells,
      coverage: [...coverage.values()],
      statsBefore: statsBaseline,
      statsAfter,
      eventLog: liveEvents,
      chatterBucket,
      requestedPositions: new Set(positionsUnderTest),
    });
    setFindings(result);
    setPhase("report");
  }, [
    statsAfter,
    cells,
    coverage,
    statsBaseline,
    liveEvents,
    chatterBucket,
    positionsUnderTest,
    invalidCounters,
  ]);

  const restart = useCallback(() => {
    const current = lifetime.current;
    current.revision++;
    current.busy = false;
    setRevision(current.revision);
    setIsBusy(false);
    setPhase("idle");
    setCoverage(new Map());
    setStatsBaseline(null);
    setStatsAfter(null);
    setFindings([]);
    setError(null);
    setInvalidCounters(false);
  }, []);

  const seenCount = [...coverage.values()].filter(
    (c) => c.status === "seen"
  ).length;

  return (
    <div className="test-wizard">
      {error && <div className="error-bar">{error}</div>}

      {phase === "idle" && (
        <div className="wizard-step">
          <p>
            Press <strong>every key once</strong> to check coverage. The wizard
            uses{" "}
            {liveAvailable
              ? "live key events"
              : "stats polling (live events unavailable)"}{" "}
            to track which keys registered.
          </p>
          <button
            className="btn btn-primary"
            disabled={isBusy}
            onClick={() => void startCoverage()}
          >
            {isBusy ? "Preparing statistics…" : "Start test"}
          </button>
        </div>
      )}

      {phase === "coverage" && (
        <div className="wizard-step">
          <h3>Coverage pass</h3>
          <p>
            Press every key once. {seenCount} / {positionsUnderTest.length}{" "}
            seen.
          </p>
          <button
            className="btn btn-primary"
            disabled={invalidCounters}
            onClick={finishCoverage}
          >
            Done pressing / show missed keys
          </button>
        </div>
      )}

      {phase === "retest" && (
        <div className="wizard-step">
          <h3>Retest pass</h3>
          {missedPositions.length === 0 ? (
            <p>All keys were seen during the coverage pass.</p>
          ) : (
            <p>
              Press each of these positions 5 times:{" "}
              <strong>{missedPositions.join(", ")}</strong>
            </p>
          )}
          <button
            className="btn btn-primary"
            disabled={isBusy || invalidCounters}
            onClick={() => void finishRetest()}
          >
            Done retesting / continue
          </button>
        </div>
      )}

      {phase === "chatter" && (
        <div className="wizard-step">
          <h3>Chatter check</h3>
          <label>
            Threshold bucket:{" "}
            <select
              value={chatterBucket}
              onChange={(e) =>
                setChatterBucket(e.target.value as ChatterBucket)
              }
            >
              <option value="lt5">&lt; 5ms</option>
              <option value="lt10">&lt; 10ms</option>
              <option value="lt20">&lt; 20ms</option>
              <option value="lt50">&lt; 50ms</option>
            </select>
          </label>
          <div>
            <button className="btn btn-primary" onClick={runDiagnosis}>
              Generate report
            </button>
          </div>
        </div>
      )}

      {phase === "report" && (
        <div className="wizard-step">
          <h3>Report</h3>
          {findings.length === 0 ? (
            <p>
              No faults detected. If a key still misbehaves, check its keymap
              binding.
            </p>
          ) : (
            <ul className="findings-list">
              {findings.map((f, i) => (
                <li
                  key={i}
                  className={`finding finding-${f.confidence}`}
                  data-testid="finding"
                >
                  <div className="finding-header">
                    <span className="finding-kind">{f.kind}</span>
                    <span className="finding-confidence">{f.confidence}</span>
                  </div>
                  <p className="finding-summary">{f.summary}</p>
                  <p className="finding-action">{f.action}</p>
                  <details>
                    <summary>Evidence</summary>
                    <ul>
                      {f.evidence.map((e, j) => (
                        <li key={j}>{e}</li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <button className="btn btn-secondary" onClick={restart}>
            Start over
          </button>
        </div>
      )}
      {phase !== "idle" && phase !== "report" && (
        <button className="btn btn-secondary" onClick={restart}>
          Start over
        </button>
      )}
    </div>
  );
}
