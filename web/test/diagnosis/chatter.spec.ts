import { diagnose } from "../../src/diagnosis/engine";
import { makeCells, makeCoverage, makeStatsMap } from "./fixtures";

describe("session chatter thresholds", () => {
  it.each([
    ["lt5", "repressLt5"],
    ["lt10", "repressLt5"],
    ["lt20", "repressLt10"],
    ["lt50", "repressLt20"],
  ] as const)("includes a shorter band in %s", (chatterBucket, field) => {
    const result = diagnose({
      cells: makeCells(),
      coverage: makeCoverage(),
      statsBefore: makeStatsMap(),
      statsAfter: makeStatsMap([{ position: 0, [field]: 1 }]),
      eventLog: [],
      chatterBucket,
    });
    expect(
      result.find((finding) => finding.kind === "CHATTER")?.positions
    ).toEqual([0]);
  });

  it("does not report unchanged historical repeats as session chatter", () => {
    const baseline = makeStatsMap([{ position: 0, repressLt50: 3 }]);
    const result = diagnose({
      cells: makeCells(),
      coverage: makeCoverage(),
      statsBefore: baseline,
      statsAfter: baseline,
      eventLog: [],
      chatterBucket: "lt50",
    });
    expect(result.filter((finding) => finding.kind === "CHATTER")).toEqual([]);
  });

  it("uses new repeats only when historical counts are nonzero", () => {
    const result = diagnose({
      cells: makeCells(),
      coverage: makeCoverage(),
      statsBefore: makeStatsMap([
        { position: 0, repressLt5: 5, repressLt20: 2 },
      ]),
      statsAfter: makeStatsMap([
        { position: 0, repressLt5: 5, repressLt20: 3 },
      ]),
      eventLog: [],
      chatterBucket: "lt50",
    });
    const finding = result.find((entry) => entry.kind === "CHATTER");
    expect(finding?.confidence).toBe("medium");
    expect(finding?.evidence[0]).toContain("repress_lt50 = 1");
  });
});
