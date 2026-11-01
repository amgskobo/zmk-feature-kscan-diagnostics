import { diagnose } from "../../src/diagnosis/engine";
import { KscanDriverType } from "../../src/proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import type { DiagnosisInput } from "../../src/diagnosis/types";
import {
  makeCells,
  makeCoverage,
  makeStatsMap,
  makeEvent,
  positionFor,
} from "./fixtures";

function baseInput(overrides: Partial<DiagnosisInput> = {}): DiagnosisInput {
  return {
    cells: makeCells(),
    coverage: makeCoverage(),
    statsAfter: makeStatsMap(),
    eventLog: [],
    chatterBucket: "lt50",
    ...overrides,
  };
}

describe("DiagnosisEngine", () => {
  describe("ROW_FAULT / COLUMN_FAULT", () => {
    it("flags a whole dead row when its columns are proven alive elsewhere", () => {
      // Row 1 (positions 3,4,5) all dead; every column has a live cell in
      // row 0 or row 2, so the columns are exonerated -> ROW_FAULT.
      const coverage = makeCoverage({
        [positionFor(1, 0)]: { status: "missed", pressCount: 0 },
        [positionFor(1, 1)]: { status: "missed", pressCount: 0 },
        [positionFor(1, 2)]: { status: "missed", pressCount: 0 },
      });
      const findings = diagnose(baseInput({ coverage }));
      const rowFault = findings.find((f) => f.kind === "ROW_FAULT");
      expect(rowFault).toBeDefined();
      expect(rowFault?.confidence).toBe("high");
      expect(rowFault?.positions.sort()).toEqual([3, 4, 5]);
      expect(rowFault?.action).toMatch(/gpio0 pin 1/);
    });

    it("flags a whole dead column when its rows are proven alive elsewhere", () => {
      const coverage = makeCoverage({
        [positionFor(0, 2)]: { status: "missed", pressCount: 0 },
        [positionFor(1, 2)]: { status: "missed", pressCount: 0 },
        [positionFor(2, 2)]: { status: "missed", pressCount: 0 },
      });
      const findings = diagnose(baseInput({ coverage }));
      const colFault = findings.find((f) => f.kind === "COLUMN_FAULT");
      expect(colFault).toBeDefined();
      expect(colFault?.positions.sort()).toEqual([2, 5, 8]);
      expect(colFault?.action).toMatch(/gpio1 pin 2/);
    });

    it("does not fire when the whole board is untested (columns not proven alive)", () => {
      const coverage = makeCoverage({});
      for (const c of coverage) {
        c.status = "missed";
        c.pressCount = 0;
      }
      const findings = diagnose(baseInput({ coverage }));
      expect(findings.find((f) => f.kind === "ROW_FAULT")).toBeUndefined();
      expect(findings.find((f) => f.kind === "COLUMN_FAULT")).toBeUndefined();
    });
  });

  describe("KEY_FAULT", () => {
    it("flags an isolated dead key whose row and column both work elsewhere", () => {
      const coverage = makeCoverage({
        [positionFor(1, 1)]: { status: "missed", pressCount: 0 },
      });
      const findings = diagnose(baseInput({ coverage }));
      const keyFault = findings.find((f) => f.kind === "KEY_FAULT");
      expect(keyFault).toBeDefined();
      expect(keyFault?.positions).toEqual([4]);
      expect(keyFault?.confidence).toBe("high");
    });

    it("does not fire for a corner key whose row/col are each single-member (no cross-check possible)", () => {
      // Use a 1-row-of-interest case: mark two keys dead in the same row so
      // ROW_FAULT case owns it instead; single isolated key with both lines
      // otherwise fully dead should not produce KEY_FAULT.
      const coverage = makeCoverage({
        [positionFor(0, 0)]: { status: "missed", pressCount: 0 },
        [positionFor(0, 1)]: { status: "missed", pressCount: 0 },
        [positionFor(0, 2)]: { status: "missed", pressCount: 0 },
        [positionFor(1, 0)]: { status: "missed", pressCount: 0 },
        [positionFor(2, 0)]: { status: "missed", pressCount: 0 },
      });
      const findings = diagnose(baseInput({ coverage }));
      // position (0,0) has neither row 0 nor column 0 alive elsewhere, so no
      // KEY_FAULT for it specifically.
      const keyFault = findings.find(
        (f) => f.kind === "KEY_FAULT" && f.positions.includes(0)
      );
      expect(keyFault).toBeUndefined();
    });
  });

  describe("CHATTER", () => {
    it("flags a position with repress_lt* > 0 at the selected bucket", () => {
      const statsAfter = makeStatsMap([{ position: 4, repressLt50: 3 }]);
      const findings = diagnose(
        baseInput({ statsAfter, chatterBucket: "lt50" })
      );
      const chatter = findings.find((f) => f.kind === "CHATTER");
      expect(chatter).toBeDefined();
      expect(chatter?.positions).toEqual([4]);
      expect(chatter?.confidence).toBe("high");
      expect(chatter?.evidence[0]).toContain("repress_lt50 = 3");
    });

    it("includes shorter bands when choosing threshold confidence", () => {
      const statsAfter = makeStatsMap([
        { position: 2, repressLt50: 1, repressLt5: 9 },
      ]);
      const findings = diagnose(
        baseInput({ statsAfter, chatterBucket: "lt50" })
      );
      const chatter = findings.find(
        (f) => f.kind === "CHATTER" && f.positions.includes(2)
      );
      expect(chatter?.confidence).toBe("high");
      expect(chatter?.evidence[0]).toContain("repress_lt50 = 10");
    });

    it("does not fire when all repress counts are zero", () => {
      const findings = diagnose(baseInput());
      expect(findings.find((f) => f.kind === "CHATTER")).toBeUndefined();
    });
  });

  describe("GHOST", () => {
    it("flags an unrequested press completing a rectangle of two held matrix keys", () => {
      // Hold (0,0) and (1,1); ghost fires at (0,1) or (1,0) since both
      // complete rectangles. We synthesize (1,0) as the unrequested press.
      const requested = new Set([positionFor(0, 0), positionFor(1, 1)]);
      const eventLog = [
        makeEvent({
          position: positionFor(0, 0),
          pressed: true,
          receivedAt: 0,
        }),
        makeEvent({
          position: positionFor(1, 1),
          pressed: true,
          receivedAt: 1,
        }),
        makeEvent({
          position: positionFor(1, 0),
          pressed: true,
          receivedAt: 2,
        }),
      ];
      const findings = diagnose(
        baseInput({ eventLog, requestedPositions: requested })
      );
      const ghost = findings.find((f) => f.kind === "GHOST");
      expect(ghost).toBeDefined();
      expect(ghost?.positions[0]).toBe(positionFor(1, 0));
    });

    it("does not fire when the device is not a MATRIX driver", () => {
      const requested = new Set([positionFor(0, 0), positionFor(1, 1)]);
      const eventLog = [
        makeEvent({
          position: positionFor(0, 0),
          pressed: true,
          receivedAt: 0,
        }),
        makeEvent({
          position: positionFor(1, 1),
          pressed: true,
          receivedAt: 1,
        }),
        makeEvent({
          position: positionFor(1, 0),
          pressed: true,
          receivedAt: 2,
        }),
      ];
      const findings = diagnose(
        baseInput({
          cells: makeCells(KscanDriverType.DIRECT),
          eventLog,
          requestedPositions: requested,
        })
      );
      expect(findings.find((f) => f.kind === "GHOST")).toBeUndefined();
    });

    it("does not fire when requestedPositions is omitted", () => {
      const eventLog = [
        makeEvent({
          position: positionFor(0, 0),
          pressed: true,
          receivedAt: 0,
        }),
        makeEvent({
          position: positionFor(1, 1),
          pressed: true,
          receivedAt: 1,
        }),
        makeEvent({
          position: positionFor(1, 0),
          pressed: true,
          receivedAt: 2,
        }),
      ];
      const findings = diagnose(baseInput({ eventLog }));
      expect(findings.find((f) => f.kind === "GHOST")).toBeUndefined();
    });
  });

  describe("UNSTABLE_LINE", () => {
    it("flags a row where every key registers presses well below the board average", () => {
      const coverage = makeCoverage({
        [positionFor(2, 0)]: { status: "seen", pressCount: 1 },
        [positionFor(2, 1)]: { status: "seen", pressCount: 1 },
        [positionFor(2, 2)]: { status: "seen", pressCount: 1 },
      });
      // Bump every other row's press count so the average is high relative
      // to row 2's flat "1".
      for (const c of coverage) {
        if (c.position < 6) c.pressCount = 10;
      }
      const findings = diagnose(baseInput({ coverage }));
      const unstable = findings.find((f) => f.kind === "UNSTABLE_LINE");
      expect(unstable).toBeDefined();
      expect(unstable?.positions.sort()).toEqual([6, 7, 8]);
      expect(unstable?.confidence).toBe("low");
    });

    it("does not fire when press counts are uniform (no line stands out)", () => {
      const findings = diagnose(baseInput());
      expect(findings.find((f) => f.kind === "UNSTABLE_LINE")).toBeUndefined();
    });
  });

  describe("SOFTWARE_SUSPECT", () => {
    it("flags a user-reported position with no electrical finding", () => {
      const findings = diagnose(
        baseInput({ userReportedPositions: new Set([positionFor(1, 1)]) })
      );
      const suspect = findings.find((f) => f.kind === "SOFTWARE_SUSPECT");
      expect(suspect).toBeDefined();
      expect(suspect?.positions).toEqual([4]);
      expect(suspect?.confidence).toBe("low");
    });

    it("does not fire when the position already has an electrical finding (chatter)", () => {
      const statsAfter = makeStatsMap([{ position: 4, repressLt50: 2 }]);
      const findings = diagnose(
        baseInput({
          statsAfter,
          userReportedPositions: new Set([positionFor(1, 1)]),
        })
      );
      expect(
        findings.find((f) => f.kind === "SOFTWARE_SUSPECT")
      ).toBeUndefined();
      expect(findings.find((f) => f.kind === "CHATTER")).toBeDefined();
    });

    it("does not fire when userReportedPositions is omitted", () => {
      const findings = diagnose(baseInput());
      expect(
        findings.find((f) => f.kind === "SOFTWARE_SUSPECT")
      ).toBeUndefined();
    });
  });

  describe("ordering", () => {
    it("sorts findings by confidence, high before medium before low", () => {
      const coverage = makeCoverage({
        [positionFor(1, 1)]: { status: "missed", pressCount: 0 }, // KEY_FAULT, high
      });
      const statsAfter = makeStatsMap([{ position: 0, repressLt50: 1 }]); // CHATTER, medium
      const findings = diagnose(
        baseInput({
          coverage,
          statsAfter,
          userReportedPositions: new Set([positionFor(2, 2)]), // SOFTWARE_SUSPECT, low
        })
      );
      const confidences = findings.map((f) => f.confidence);
      const highIdx = confidences.indexOf("high");
      const medIdx = confidences.indexOf("medium");
      const lowIdx = confidences.indexOf("low");
      expect(highIdx).toBeLessThan(medIdx);
      expect(medIdx).toBeLessThan(lowIdx);
    });
  });
});
