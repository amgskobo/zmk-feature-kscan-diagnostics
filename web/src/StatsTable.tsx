/**
 * Raw per-position counters table with reset button and CSV export
 * (DESIGN.md §7 screen 4).
 */
import type { StatsByPosition } from "./kscanDiagnosticsTypes";
import { statsToCsv } from "./statsCsv";

export interface StatsTableProps {
  stats: StatsByPosition | null;
  onRefresh: () => void;
  onReset: () => void;
  isLoading?: boolean;
}

function downloadCsv(csv: string) {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "kscan-diagnostics-stats.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function StatsTable({
  stats,
  onRefresh,
  onReset,
  isLoading,
}: StatsTableProps) {
  const rows = stats
    ? [...stats.values()].sort((a, b) => a.position - b.position)
    : [];

  return (
    <div className="stats-table">
      <div className="stats-table-toolbar">
        <button
          className="btn btn-sm btn-secondary"
          onClick={onRefresh}
          disabled={isLoading}
        >
          {isLoading ? "Refreshing…" : "Refresh"}
        </button>
        <button
          className="btn btn-sm btn-danger"
          onClick={onReset}
          disabled={isLoading}
        >
          Reset counters
        </button>
        <button
          className="btn btn-sm btn-secondary"
          onClick={() => stats && downloadCsv(statsToCsv(stats))}
          disabled={!stats || stats.size === 0}
        >
          Export CSV
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="hint-text">No stats loaded yet.</p>
      ) : (
        <div className="stats-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Pos</th>
                <th>Presses</th>
                <th>Releases</th>
                <th>Min press (ms)</th>
                <th>Min repress gap (ms)</th>
                <th>&lt;5ms</th>
                <th>5–&lt;10ms</th>
                <th>10–&lt;20ms</th>
                <th>20–&lt;50ms</th>
                <th>Last source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.position} data-testid={`stats-row-${r.position}`}>
                  <td>{r.position}</td>
                  <td>{r.presses}</td>
                  <td>{r.releases}</td>
                  <td>
                    {r.minPressDurationMs === 0xffff
                      ? "-"
                      : r.minPressDurationMs}
                  </td>
                  <td>
                    {r.minRepressGapMs === 0xffff ? "-" : r.minRepressGapMs}
                  </td>
                  <td>{r.repressLt5}</td>
                  <td>{r.repressLt10}</td>
                  <td>{r.repressLt20}</td>
                  <td>{r.repressLt50}</td>
                  <td>{r.lastSource === 255 ? "local" : r.lastSource}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
