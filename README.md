# esxtopviz

Lightweight, perfmon-style viewer for large esxtop/PDH CSV exports. It builds a sparse index and serves a local web UI for interactive charting.

## Requirements

- Go 1.22+

## Run

```bash
cd /home/pringles/Desktop/esxtopviz
go run ./cmd/esxtopviz -file /home/pringles/Desktop/esxtop-va1pv1507.us.ad.lfg.com-2026-02-09T15_30.csv -port 8080
```

Open `http://localhost:8080` in your browser.

## Usage

- Select counters on the left, click **Load**.
- Drag on the chart to zoom into a time range.
- Hover to inspect values.
- Use report buttons to quickly select related counters.

## Notes

- The CSV parser assumes each record is on a single line (typical for PDH/Perfmon CSV exports).
- For very large files, repeated zooms re-scan a time window to keep memory usage low.
