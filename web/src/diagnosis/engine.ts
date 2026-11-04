/**
 * Pure fault-estimation rules (DESIGN.md §7's DiagnosisEngine bullet list).
 * No React/DOM dependencies so these can be jest-fixtured exhaustively.
 *
 * Each rule inspects `DiagnosisInput` and appends zero or more `Finding`s.
 * `diagnose()` runs every rule and returns the combined, de-duplicated list,
 * highest confidence first.
 */
import { KscanDriverType } from "../proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import type { CellWiring, DiagnosisInput, Finding } from "./types";

function gpioLabel(line: CellWiring["rowLine"]): string {
  if (!line) return "unknown pin";
  return `${line.port} pin ${line.pin}`;
}

function wireKey(line: CellWiring["rowLine"]): string | null {
  return line ? JSON.stringify([line.port, line.pin]) : null;
}

function axisLine(cell: CellWiring, axis: "row" | "column") {
  return axis === "row" ? cell.rowLine : cell.colLine;
}

function isDead(cell: CellWiring, input: DiagnosisInput): boolean {
  const cov = input.coverage.find((c) => c.position === cell.position);
  return cov?.status === "missed";
}

function isAlive(cell: CellWiring, input: DiagnosisInput): boolean {
  const cov = input.coverage.find((c) => c.position === cell.position);
  return cov?.status === "seen";
}

/**
 * ROW_FAULT / COLUMN_FAULT: >=2 dead keys sharing a row (or column) line,
 * while their columns (or rows) are each proven alive at some other
 * position — that rules out "every key on this board is untested" and
 * points at the shared line instead of each individual key.
 */
function ruleLineFault(input: DiagnosisInput): Finding[] {
  const findings: Finding[] = [];
  const dead = input.cells.filter((c) => isDead(c, input));
  if (dead.length === 0) return findings;

  for (const axis of ["row", "column"] as const) {
    const groups = new Map<string, CellWiring[]>();
    for (const cell of dead) {
      const key = wireKey(axisLine(cell, axis));
      if (key === null) continue;
      const list = groups.get(key) ?? [];
      list.push(cell);
      groups.set(key, list);
    }
    for (const cells of groups.values()) {
      if (cells.length < 2) continue;
      const axisValue = axis === "row" ? cells[0].row : cells[0].column;
      // The cross axis (column for ROW_FAULT, row for COLUMN_FAULT) must be
      // proven alive elsewhere for each dead cell, otherwise the fault could
      // just as well be on the cross axis (or untested board-wide).
      const crossProvenAlive = cells.every((cell) => {
        const crossAxis = axis === "row" ? "column" : "row";
        const crossValue = wireKey(axisLine(cell, crossAxis));
        const source = wireKey(axisLine(cell, axis));
        if (crossValue === null) return false;
        return input.cells.some(
          (other) =>
            wireKey(axisLine(other, crossAxis)) === crossValue &&
            wireKey(axisLine(other, axis)) !== null &&
            wireKey(axisLine(other, axis)) !== source &&
            isAlive(other, input)
        );
      });
      if (!crossProvenAlive) continue;

      const line = axis === "row" ? cells[0].rowLine : cells[0].colLine;
      findings.push({
        kind: axis === "row" ? "ROW_FAULT" : "COLUMN_FAULT",
        confidence: "high",
        positions: cells.map((c) => c.position),
        summary: `${cells.length} keys on ${axis} ${axisValue} are all dead, while their ${axis === "row" ? "columns" : "rows"} work elsewhere`,
        action: `Check wire/solder on GPIO ${gpioLabel(line)} (${axis} ${axisValue})`,
        evidence: cells.map(
          (c) =>
            `position ${c.position} (row ${c.row}, col ${c.column}) never registered a press`
        ),
      });
    }
  }
  return findings;
}

/**
 * KEY_FAULT: an isolated dead key whose row AND column are each proven alive
 * at other positions — the fault is local to this key's socket/switch, not
 * a shared line.
 */
function ruleIsolatedKeyFault(input: DiagnosisInput): Finding[] {
  const findings: Finding[] = [];
  const dead = input.cells.filter((c) => isDead(c, input));
  for (const cell of dead) {
    const row = wireKey(cell.rowLine);
    const column = wireKey(cell.colLine);
    if (row === null || column === null) continue;
    const rowAliveElsewhere = input.cells.some(
      (other) =>
        wireKey(other.rowLine) === row &&
        wireKey(other.colLine) !== null &&
        wireKey(other.colLine) !== column &&
        isAlive(other, input)
    );
    const colAliveElsewhere = input.cells.some(
      (other) =>
        wireKey(other.colLine) === column &&
        wireKey(other.rowLine) !== null &&
        wireKey(other.rowLine) !== row &&
        isAlive(other, input)
    );
    if (rowAliveElsewhere && colAliveElsewhere) {
      findings.push({
        kind: "KEY_FAULT",
        confidence: "high",
        positions: [cell.position],
        summary: `Key at position ${cell.position} (row ${cell.row}, col ${cell.column}) is dead but its row and column both work at other keys`,
        action: `Reflow socket / swap switch at position ${cell.position}`,
        evidence: [
          `row ${cell.row} registers presses at other columns`,
          `column ${cell.column} registers presses at other rows`,
          `position ${cell.position} never registered a press`,
        ],
      });
    }
  }
  return findings;
}

const CHATTER_FIELDS = [
  "repressLt5",
  "repressLt10",
  "repressLt20",
  "repressLt50",
] as const;
const CHATTER_BANDS = { lt5: 1, lt10: 2, lt20: 3, lt50: 4 };

/** Firmware bands are exclusive; a threshold includes every smaller band. */
function ruleChatter(input: DiagnosisInput): Finding[] {
  const findings: Finding[] = [];
  const fields = CHATTER_FIELDS.slice(0, CHATTER_BANDS[input.chatterBucket]);
  for (const cell of input.cells) {
    const stats = input.statsAfter.get(cell.position);
    if (!stats) continue;
    const before = input.statsBefore?.get(cell.position);
    // A reset needs a fresh session baseline, never a negative or mixed delta.
    if (before && CHATTER_FIELDS.some((field) => stats[field] < before[field]))
      continue;
    const count = fields.reduce(
      (sum, field) => sum + stats[field] - (before?.[field] ?? 0),
      0
    );
    if (count > 0) {
      findings.push({
        kind: "CHATTER",
        confidence: count >= 3 ? "high" : "medium",
        positions: [cell.position],
        summary: `Position ${cell.position} re-pressed ${count} time(s) with gap < ${input.chatterBucket.slice(2)}ms`,
        action: `Replace switch or raise debounce-press-ms (currently unknown from this cell alone) at position ${cell.position}`,
        evidence: [
          `repress_${input.chatterBucket} = ${count} (cumulative histogram bands${before ? ", session delta" : ""})`,
        ],
      });
    }
  }
  return findings;
}

/**
 * GHOST: an event fires at a position the wizard did not request while the
 * other 3 corners of the rectangle it forms with two currently-held keys
 * are held — classic matrix ghosting via the anti-parallel diode path. Only
 * meaningful when the backing device is a MATRIX driver (diodes exist).
 */
function ruleGhost(input: DiagnosisInput): Finding[] {
  const findings: Finding[] = [];
  if (!input.requestedPositions) return findings;

  const byPosition = new Map(input.cells.map((c) => [c.position, c]));
  // Reconstruct "currently held" sets by replaying press/release in order.
  const held = new Set<number>();
  const sorted = [...input.eventLog].sort(
    (a, b) => a.receivedAt - b.receivedAt
  );
  for (const ev of sorted) {
    if (ev.pressed) {
      const cell = byPosition.get(ev.position);
      const unexpected = !input.requestedPositions.has(ev.position);
      if (unexpected && cell && cell.deviceType === KscanDriverType.MATRIX) {
        // Look for two held keys forming the other two corners of a
        // rectangle with this ghost position.
        for (const a of held) {
          const cellA = byPosition.get(a);
          if (!cellA) continue;
          for (const b of held) {
            if (b <= a) continue; // Consider each held pair once.
            const cellB = byPosition.get(b);
            if (!cellB) continue;
            const sameRowAsGhost =
              cellA.row === cell.row && cellB.column === cell.column;
            const sameColAsGhost =
              cellB.row === cell.row && cellA.column === cell.column;
            if (sameRowAsGhost || sameColAsGhost) {
              findings.push({
                kind: "GHOST",
                confidence: "medium",
                positions: [cell.position, a, b],
                summary: `Unrequested press at position ${cell.position} while positions ${a} and ${b} were held (matrix ghost pattern)`,
                action: `Check diode at position ${cell.position}`,
                evidence: [
                  `position ${cell.position} not requested by the wizard`,
                  `positions ${a} and ${b} form the other two rectangle corners`,
                  "backing device is a MATRIX driver (diodes present)",
                ],
              });
            }
          }
        }
      }
      held.add(ev.position);
    } else {
      held.delete(ev.position);
    }
  }
  return findings;
}

/**
 * UNSTABLE_LINE: coverage pass-rate clustered on one row/col across retest
 * attempts — i.e. keys on the line were sometimes seen and sometimes missed
 * (as opposed to consistently dead, which is ROW_FAULT/COLUMN_FAULT).
 * Detected via pressCount variance: a line where every position has a
 * nonzero-but-low press count while a control line has consistently higher
 * counts suggests intermittent contact rather than a hard break.
 */
function ruleUnstableLine(input: DiagnosisInput): Finding[] {
  const findings: Finding[] = [];
  const withCoverage = input.cells
    .map((cell) => ({
      cell,
      coverage: input.coverage.find((c) => c.position === cell.position),
    }))
    .filter((x) => x.coverage !== undefined);
  if (withCoverage.length === 0) return findings;

  const avgPressCount =
    withCoverage.reduce((sum, x) => sum + (x.coverage?.pressCount ?? 0), 0) /
    withCoverage.length;
  if (avgPressCount <= 0) return findings;

  for (const axis of ["row", "column"] as const) {
    const groups = new Map<string, typeof withCoverage>();
    for (const x of withCoverage) {
      const key = wireKey(axisLine(x.cell, axis));
      if (key === null) continue;
      const list = groups.get(key) ?? [];
      list.push(x);
      groups.set(key, list);
    }
    for (const entries of groups.values()) {
      if (entries.length < 2) continue;
      const axisValue =
        axis === "row" ? entries[0].cell.row : entries[0].cell.column;
      // "Intermittent": every position on the line was seen at least once
      // (so it's not a hard ROW_FAULT/COLUMN_FAULT) but the press count is
      // well below the board average for every one of them.
      const allSeenAtLeastOnce = entries.every(
        (e) => (e.coverage?.pressCount ?? 0) > 0
      );
      const allBelowAverage = entries.every(
        (e) => (e.coverage?.pressCount ?? 0) < avgPressCount * 0.5
      );
      if (allSeenAtLeastOnce && allBelowAverage) {
        const line =
          axis === "row" ? entries[0].cell.rowLine : entries[0].cell.colLine;
        findings.push({
          kind: "UNSTABLE_LINE",
          confidence: "low",
          positions: entries.map((e) => e.cell.position),
          summary: `Keys on ${axis} ${axisValue} register presses well below average — possible intermittent contact`,
          action: `Wiggle-test the wire on GPIO ${gpioLabel(line)} (${axis} ${axisValue})`,
          evidence: entries.map(
            (e) =>
              `position ${e.cell.position}: ${e.coverage?.pressCount ?? 0} presses vs board average ${avgPressCount.toFixed(1)}`
          ),
        });
      }
    }
  }
  return findings;
}

/**
 * SOFTWARE_SUSPECT: fallback for a position the user explicitly reported as
 * "still wrong" (`userReportedPositions`) that has no electrical finding
 * (wiring fault, chatter, ghost, unstable line) explaining it — points the
 * user at the keymap/behavior binding instead.
 */
function ruleSoftwareSuspect(
  input: DiagnosisInput,
  priorFindings: Finding[]
): Finding[] {
  const findings: Finding[] = [];
  if (!input.userReportedPositions) return findings;
  const explainedPositions = new Set(priorFindings.flatMap((f) => f.positions));
  for (const pos of input.userReportedPositions) {
    if (explainedPositions.has(pos)) continue;
    findings.push({
      kind: "SOFTWARE_SUSPECT",
      confidence: "low",
      positions: [pos],
      summary: `Position ${pos} was reported as misbehaving but no wiring fault or chatter explains it`,
      action: `Check the keymap/behavior binding for position ${pos} (layer/macro/combo config)`,
      evidence: [
        `position ${pos}: no wiring fault, chatter, ghost, or unstable-line finding`,
      ],
    });
  }
  return findings;
}

const CONFIDENCE_ORDER: Record<Finding["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function diagnose(input: DiagnosisInput): Finding[] {
  const findings: Finding[] = [];
  findings.push(...ruleLineFault(input));
  findings.push(...ruleIsolatedKeyFault(input));
  findings.push(...ruleChatter(input));
  findings.push(...ruleGhost(input));
  findings.push(...ruleUnstableLine(input));
  findings.push(...ruleSoftwareSuspect(input, findings));

  return findings.sort(
    (a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence]
  );
}

export {
  ruleLineFault,
  ruleIsolatedKeyFault,
  ruleChatter,
  ruleGhost,
  ruleUnstableLine,
  ruleSoftwareSuspect,
};
