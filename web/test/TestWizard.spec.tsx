import { act, fireEvent, render, screen } from "@testing-library/react";
import { TestWizard } from "../src/TestWizard";
import { KscanDriverType } from "../src/proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import type { CellWiring, DiagnosisKeyEvent } from "../src/diagnosis/types";
import type {
  PositionStatsEntry,
  StatsByPosition,
} from "../src/kscanDiagnosticsTypes";

function makeCells(count: number): CellWiring[] {
  return Array.from({ length: count }, (_, i) => ({
    position: i,
    row: Math.floor(i / 3),
    column: i % 3,
    deviceType: KscanDriverType.MATRIX,
    rowLine: {
      index: 0,
      port: "gpio0",
      pin: Math.floor(i / 3),
      activeLow: true,
      dtFlags: 0,
    },
    colLine: {
      index: 1,
      port: "gpio1",
      pin: i % 3,
      activeLow: true,
      dtFlags: 0,
    },
  }));
}

function makeStatsEntry(
  overrides: Partial<PositionStatsEntry> = {}
): PositionStatsEntry {
  return {
    position: 0,
    presses: 0,
    releases: 0,
    minPressDurationMs: 0xffff,
    minRepressGapMs: 0xffff,
    repressLt5: 0,
    repressLt10: 0,
    repressLt20: 0,
    repressLt50: 0,
    lastSource: 255,
    ...overrides,
  };
}

function makeStatsMap(
  count: number,
  presses: (i: number) => number
): StatsByPosition {
  const map = new Map<number, PositionStatsEntry>();
  for (let i = 0; i < count; i++) {
    map.set(i, makeStatsEntry({ position: i, presses: presses(i) }));
  }
  return map;
}

function makeEvent(
  position: number,
  pressed: boolean,
  receivedAt: number
): DiagnosisKeyEvent {
  return { position, pressed, receivedAt };
}

describe("TestWizard", () => {
  it("walks coverage -> retest -> chatter -> report using live events", async () => {
    const cells = makeCells(9);
    let liveEvents: DiagnosisKeyEvent[] = [];
    const fetchStats = jest.fn().mockResolvedValue(makeStatsMap(9, () => 1));

    const { rerender } = render(
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={liveEvents}
        liveAvailable={true}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    expect(screen.getByText(/Coverage pass/i)).toBeInTheDocument();

    // Simulate 8 of 9 keys pressed via live events (position 4 missed).
    liveEvents = [8, 7, 6, 5, 3, 2, 1, 0].map((position) => ({
      position,
      pressed: true,
      receivedAt: 0,
    }));
    rerender(
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={liveEvents}
        liveAvailable={true}
      />
    );
    expect(screen.getByText(/8 \/ 9 seen/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Done pressing/i));
    expect(screen.getByText(/Retest pass/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Press each of these positions 5 times/i).textContent
    ).toContain("4");

    await act(async () => {
      fireEvent.click(screen.getByText(/Done retesting/i));
    });
    expect(fetchStats).toHaveBeenCalled();
    expect(screen.getByText(/Chatter check/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Generate report"));
    expect(screen.getByText(/Report/i)).toBeInTheDocument();
  });

  it("reports a mapped ghost only from an explicit requested-key window", async () => {
    const cells = makeCells(9);
    let liveEvents: DiagnosisKeyEvent[] = [];
    const fetchStats = jest.fn().mockResolvedValue(makeStatsMap(9, () => 1));
    const props = () => ({
      cells,
      fetchStats,
      liveEvents,
      liveAvailable: true,
    });
    const { rerender } = render(<TestWizard {...props()} />);
    await act(async () => fireEvent.click(screen.getByText("Start test")));
    fireEvent.click(screen.getByText(/Done pressing/));
    await act(async () => fireEvent.click(screen.getByText(/Done retesting/)));
    // A free coverage press log must not be relabeled as a requested ghost test.
    liveEvents = [
      makeEvent(0, true, 3),
      makeEvent(3, true, 2),
      makeEvent(1, true, 1),
    ];
    rerender(<TestWizard {...props()} />);
    fireEvent.click(screen.getByText("Start ghost check"));
    expect(screen.getByText(/Hold positions/).textContent).toContain(
      "do not press position 0"
    );
    liveEvents = [
      makeEvent(0, true, 13),
      makeEvent(4, true, 12),
      makeEvent(3, true, 11),
      makeEvent(1, true, 10),
      ...liveEvents,
    ];
    rerender(<TestWizard {...props()} />);
    fireEvent.click(screen.getByText("Finish ghost check"));
    fireEvent.click(screen.getByText("Generate report"));
    expect(screen.getByText("GHOST")).toBeInTheDocument();
    expect(
      screen.getByText(/Unrequested press at position 0/)
    ).toBeInTheDocument();
  });

  it("does not diagnose free coverage events as ghosts when the optional check was skipped", async () => {
    const cells = makeCells(9);
    const fetchStats = jest.fn().mockResolvedValue(makeStatsMap(9, () => 1));
    render(
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveAvailable={true}
        liveEvents={[
          makeEvent(0, true, 3),
          makeEvent(3, true, 2),
          makeEvent(1, true, 1),
        ]}
      />
    );
    await act(async () => fireEvent.click(screen.getByText("Start test")));
    fireEvent.click(screen.getByText(/Done pressing/));
    await act(async () => fireEvent.click(screen.getByText(/Done retesting/)));
    fireEvent.click(screen.getByText("Generate report"));
    expect(screen.queryByText("GHOST")).not.toBeInTheDocument();
  });

  it("discards an interrupted ghost window without resuming when live view returns", async () => {
    const cells = makeCells(9);
    const fetchStats = jest.fn().mockResolvedValue(makeStatsMap(9, () => 1));
    let liveAvailable = true;
    let liveEvents: DiagnosisKeyEvent[] = [];
    const view = () => (
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={liveEvents}
        liveAvailable={liveAvailable}
      />
    );
    const { rerender } = render(view());
    await act(async () => fireEvent.click(screen.getByText("Start test")));
    fireEvent.click(screen.getByText(/Done pressing/));
    await act(async () => fireEvent.click(screen.getByText(/Done retesting/)));
    fireEvent.click(screen.getByText("Start ghost check"));
    liveEvents = [
      makeEvent(0, true, 13),
      makeEvent(4, true, 12),
      makeEvent(3, true, 11),
      makeEvent(1, true, 10),
    ];
    rerender(view());
    expect(screen.getByText("Generate report")).toBeDisabled();

    liveAvailable = false;
    rerender(view());
    expect(screen.getByText(/Live view stopped/)).toBeInTheDocument();
    expect(screen.getByText("Start ghost check")).toBeDisabled();
    expect(screen.queryByText("Finish ghost check")).not.toBeInTheDocument();
    expect(screen.getByText("Generate report")).toBeEnabled();

    liveAvailable = true;
    rerender(view());
    expect(screen.getByText("Start ghost check")).toBeEnabled();
    expect(screen.queryByText("Finish ghost check")).not.toBeInTheDocument();
    expect(screen.getByText(/Live view stopped/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Generate report"));
    expect(screen.queryByText("GHOST")).not.toBeInTheDocument();
  });

  it("falls back to stats-diff polling when live events are unavailable", async () => {
    jest.useFakeTimers();
    const cells = makeCells(4);
    let callCount = 0;
    const fetchStats = jest.fn().mockImplementation(() => {
      callCount++;
      // First call is the baseline (all zero); subsequent calls show
      // position 0 pressed once.
      if (callCount === 1) return Promise.resolve(makeStatsMap(4, () => 0));
      return Promise.resolve(makeStatsMap(4, (i) => (i === 0 ? 1 : 0)));
    });

    render(
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={false}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    expect(fetchStats).toHaveBeenCalledTimes(1); // baseline fetch

    await act(async () => {
      jest.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(screen.getByText(/1 \/ 4 seen/i)).toBeInTheDocument();
    jest.useRealTimers();
  });

  it("shows 'no faults detected' when diagnosis finds nothing", async () => {
    const cells = makeCells(4);
    const fetchStats = jest.fn().mockResolvedValue(makeStatsMap(4, () => 1));
    render(
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={true}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    fireEvent.click(screen.getByText(/Done pressing/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/Done retesting/i));
    });
    fireEvent.click(screen.getByText("Generate report"));

    expect(screen.getByText(/No faults detected/i)).toBeInTheDocument();
  });

  it("reports coverage changes via onCoverageChange", () => {
    const cells = makeCells(2);
    const fetchStats = jest.fn().mockResolvedValue(new Map());
    const onCoverageChange = jest.fn();
    render(
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={true}
        onCoverageChange={onCoverageChange}
      />
    );
    expect(onCoverageChange).toHaveBeenCalled();
  });
});

const saturationCases = (
  [
    "presses",
    "releases",
    "repressLt5",
    "repressLt10",
    "repressLt20",
    "repressLt50",
  ] as const
).flatMap((field) =>
  [false, true].map((liveAvailable) => ({ field, liveAvailable }))
);

describe("counter saturation during a run", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(saturationCases)(
    "invalidates $field saturation (live=$liveAvailable)",
    async ({ field, liveAvailable }) => {
      jest.useFakeTimers();
      const baseline = makeStatsMap(2, () => 0);
      baseline.get(0)![field] = 0xfffe;
      const after = makeStatsMap(2, () => 0);
      after.get(0)![field] = 0xffff;
      const fetchStats = jest
        .fn()
        .mockResolvedValueOnce(baseline)
        .mockResolvedValue(after);
      render(
        <TestWizard
          cells={makeCells(2)}
          fetchStats={fetchStats}
          liveEvents={[]}
          liveAvailable={liveAvailable}
        />
      );
      await act(async () => {
        fireEvent.click(screen.getByText("Start test"));
      });
      if (liveAvailable) {
        fireEvent.click(screen.getByText(/Done pressing/));
        await act(async () => {
          fireEvent.click(screen.getByText(/Done retesting/));
        });
        expect(screen.getByText(/Done retesting/)).toBeDisabled();
      } else {
        await act(async () => {
          jest.advanceTimersByTime(600);
        });
        expect(screen.getByText(/Done pressing/)).toBeDisabled();
      }
      expect(screen.getByText(/Counters are saturated/)).toBeInTheDocument();
      expect(screen.queryByText(/Chatter check/)).not.toBeInTheDocument();
    }
  );

  it("ignores saturated counters for positions outside the tested layout", async () => {
    const baseline = makeStatsMap(3, (position) =>
      position === 2 ? 0xffff : 0
    );
    const after = makeStatsMap(3, (position) => (position === 2 ? 0xffff : 1));
    const fetchStats = jest
      .fn()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValue(after);
    render(
      <TestWizard
        cells={makeCells(2)}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={true}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    fireEvent.click(screen.getByText(/Done pressing/));
    await act(async () => {
      fireEvent.click(screen.getByText(/Done retesting/));
    });
    expect(screen.getByText(/Chatter check/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Counters are saturated/)
    ).not.toBeInTheDocument();
  });
});

describe("wizard session snapshots", () => {
  it("reconciles overlapping statistics and live events before diagnosis", async () => {
    jest.useFakeTimers();
    try {
      const cells = makeCells(9);
      const snapshot = makeStatsMap(9, (position) => (position < 6 ? 2 : 1));
      const fetchStats = jest
        .fn()
        .mockResolvedValueOnce(makeStatsMap(9, () => 0))
        .mockResolvedValue(snapshot);
      const onCoverageChange = jest.fn();
      const view = (
        liveAvailable: boolean,
        liveEvents: DiagnosisKeyEvent[]
      ) => (
        <TestWizard
          cells={cells}
          fetchStats={fetchStats}
          liveEvents={liveEvents}
          liveAvailable={liveAvailable}
          onCoverageChange={onCoverageChange}
        />
      );
      const { rerender } = render(view(false, []));
      await act(async () => {
        fireEvent.click(screen.getByText("Start test"));
      });
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(screen.getByText(/9 \/ 9 seen/)).toBeInTheDocument();

      // Activation can deliver events already included in the last stats page.
      rerender(
        view(
          true,
          [5, 4, 3, 2, 1, 0].map((position) => ({
            position,
            pressed: true,
            receivedAt: 1000,
          }))
        )
      );
      fireEvent.click(screen.getByText(/Done pressing/));
      await act(async () => {
        fireEvent.click(screen.getByText(/Done retesting/));
      });
      fireEvent.click(screen.getByText("Generate report"));
      expect(screen.getByText(/No faults detected/)).toBeInTheDocument();
      const final = onCoverageChange.mock.lastCall![0];
      expect(final.get(0).pressCount).toBe(2);
      expect(final.get(8).pressCount).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([true, false])(
    "captures a baseline before coverage (live=%s)",
    async (liveAvailable) => {
      const fetchStats = jest.fn().mockResolvedValue(makeStatsMap(2, () => 0));
      render(
        <TestWizard
          cells={makeCells(2)}
          fetchStats={fetchStats}
          liveEvents={[]}
          liveAvailable={liveAvailable}
        />
      );
      await act(async () => {
        fireEvent.click(screen.getByText("Start test"));
      });
      expect(fetchStats).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Coverage pass/)).toBeInTheDocument();
    }
  );

  it("consumes a new event when a full history replaces its oldest entry", async () => {
    const cells = makeCells(2);
    const history: DiagnosisKeyEvent[] = Array.from(
      { length: 500 },
      (_, i) => ({
        position: 0,
        pressed: false,
        receivedAt: 500 - i,
      })
    );
    const fetchStats = jest.fn().mockResolvedValue(makeStatsMap(2, () => 0));
    const view = (events: DiagnosisKeyEvent[]) => (
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={events}
        liveAvailable={true}
      />
    );
    const { rerender } = render(view(history));
    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    rerender(
      view([
        { position: 1, pressed: true, receivedAt: 1000 },
        ...history.slice(0, 499),
      ])
    );
    expect(screen.getByText(/1 \/ 2 seen/)).toBeInTheDocument();
    // The same retained prefix must not count again on a phase transition.
    fireEvent.click(screen.getByText(/Done pressing/));
    expect(screen.getByText(/Retest pass/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Press each of these positions 5 times/)
    ).toHaveTextContent("0");
  });

  it("keeps a failed baseline out of coverage and allows retry", async () => {
    const fetchStats = jest
      .fn()
      .mockRejectedValueOnce(new Error("Synthetic statistics failure"))
      .mockResolvedValue(makeStatsMap(2, () => 0));
    render(
      <TestWizard
        cells={makeCells(2)}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={true}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    expect(screen.queryByText(/Coverage pass/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Synthetic statistics failure")
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    expect(screen.getByText(/Coverage pass/)).toBeInTheDocument();
  });

  it("requires a new baseline after counters reset", async () => {
    const fetchStats = jest
      .fn()
      .mockResolvedValueOnce(makeStatsMap(2, () => 3))
      .mockResolvedValue(makeStatsMap(2, () => 0));
    render(
      <TestWizard
        cells={makeCells(2)}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={true}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    fireEvent.click(screen.getByText(/Done pressing/));
    await act(async () => {
      fireEvent.click(screen.getByText(/Done retesting/));
    });
    expect(screen.getByText(/Counters were reset/)).toBeInTheDocument();
    expect(screen.queryByText(/Chatter check/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Start over"));
    expect(screen.getByText("Start test")).toBeEnabled();
  });

  it("explains saturated counters before starting a test", async () => {
    const fetchStats = jest
      .fn()
      .mockResolvedValue(makeStatsMap(2, () => 0xffff));
    render(
      <TestWizard
        cells={makeCells(2)}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={true}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    expect(screen.getByText(/Counters are saturated/)).toBeInTheDocument();
    expect(screen.queryByText(/Coverage pass/)).not.toBeInTheDocument();
  });

  it("does not revive a retired run when its final read completes late", async () => {
    let complete!: (value: StatsByPosition) => void;
    const pending = new Promise<StatsByPosition>((resolve) => {
      complete = resolve;
    });
    const fetchStats = jest
      .fn()
      .mockResolvedValueOnce(makeStatsMap(2, () => 0))
      .mockReturnValueOnce(pending);
    render(
      <TestWizard
        cells={makeCells(2)}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={true}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    fireEvent.click(screen.getByText(/Done pressing/));
    fireEvent.click(screen.getByText(/Done retesting/));
    fireEvent.click(screen.getByText("Start over"));
    await act(async () => {
      complete(makeStatsMap(2, () => 1));
    });
    expect(screen.getByText("Start test")).toBeInTheDocument();
    expect(screen.queryByText(/Chatter check/)).not.toBeInTheDocument();
  });

  it("keeps one fallback poll in flight at a time", async () => {
    jest.useFakeTimers();
    let complete!: (value: StatsByPosition) => void;
    const pending = new Promise<StatsByPosition>((resolve) => {
      complete = resolve;
    });
    const fetchStats = jest
      .fn()
      .mockResolvedValueOnce(makeStatsMap(2, () => 0))
      .mockReturnValueOnce(pending)
      .mockResolvedValue(makeStatsMap(2, () => 1));
    render(
      <TestWizard
        cells={makeCells(2)}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={false}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    await act(async () => {
      jest.advanceTimersByTime(1600);
    });
    expect(fetchStats).toHaveBeenCalledTimes(2);
    await act(async () => {
      complete(makeStatsMap(2, () => 1));
    });
    expect(screen.getByText(/2 \/ 2 seen/)).toBeInTheDocument();
    jest.useRealTimers();
  });
});
