/**
 * Pure types for the DiagnosisEngine (DESIGN.md §7). Framework-free so rules
 * can be jest-tested with plain fixtures.
 */
import type { GpioPin } from "../proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import type { KscanDriverType } from "../proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import type { PositionStatsEntry } from "../kscanDiagnosticsTypes";

/** Per-position coverage state as tracked by the TestWizard. */
export type CoverageStatus = "untested" | "seen" | "missed";

export interface PositionCoverage {
  position: number;
  status: CoverageStatus;
  /** How many presses were observed for this position during the current wizard run. */
  pressCount: number;
}

/** A single (row, column) cell's wiring, resolved from Topology. Only the
 * fields the diagnosis rules need — see kscanDiagnosticsTypes.PositionWiring
 * for the richer UI-facing shape. */
export interface CellWiring {
  position: number;
  row: number;
  column: number;
  /** Device driver type backing this cell — GHOST rule only fires for MATRIX. */
  deviceType: KscanDriverType;
  rowLine: GpioPin | null;
  colLine: GpioPin | null;
}

/** A recorded live key event, from useInputStream or synthesized from stats polling. */
export interface DiagnosisKeyEvent {
  position: number;
  pressed: boolean;
  receivedAt: number;
}

export interface DiagnosisInput {
  /** Wiring for every position covered by the layout under test. */
  cells: CellWiring[];
  /** Coverage state per position from the wizard's coverage/retest passes. */
  coverage: PositionCoverage[];
  /** Stats snapshot before the test session started (for diffing), keyed by position. */
  statsBefore?: Map<number, PositionStatsEntry>;
  /** Stats snapshot at diagnosis time, keyed by position. */
  statsAfter: Map<number, PositionStatsEntry>;
  /** Live event log observed during the session (may be empty if input-stream unavailable). */
  eventLog: DiagnosisKeyEvent[];
  /** Chatter threshold bucket the user picked in the UI. */
  chatterBucket: "lt5" | "lt10" | "lt20" | "lt50";
  /**
   * Positions explicitly requested during the supplied ghost-check window.
   * Presses outside this set are candidates for the GHOST heuristic.
   * When omitted, GHOST is skipped (needs an explicit "requested" set).
   */
  requestedPositions?: Set<number>;
  /**
   * Positions the user explicitly reported as "still wrong" (e.g. wrong
   * character typed) even though the wizard sees a normal press — the seed
   * set for SOFTWARE_SUSPECT. Electrically-fine positions not in this set
   * never get a SOFTWARE_SUSPECT finding, so the fallback only fires when a
   * user complaint is unexplained by any wiring/chatter finding.
   */
  userReportedPositions?: Set<number>;
}

export type FindingKind =
  | "ROW_FAULT"
  | "COLUMN_FAULT"
  | "KEY_FAULT"
  | "CHATTER"
  | "GHOST"
  | "UNSTABLE_LINE"
  | "SOFTWARE_SUSPECT";

export type Confidence = "high" | "medium" | "low";

export interface Finding {
  kind: FindingKind;
  confidence: Confidence;
  /** Positions this finding concerns. */
  positions: number[];
  /** Human-readable summary. */
  summary: string;
  /** Concrete suggested action, e.g. "check wire/solder on GPIO gpio0 pin 5". */
  action: string;
  /** Evidence strings citing what fired the rule, for the report screen. */
  evidence: string[];
}
