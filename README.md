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
- You can load a different CSV at runtime from the **Dataset** file picker and **Open Selected CSV**.
- Drag on the chart to zoom into a time range.
- Double-click the chart to zoom out one level.
- When zoomed, use the bottom slider to pan the zoom window.
- Use **Zoom Out** or **Reset Zoom** to navigate back.
- Hover to inspect values.
- Click **Screenshot** to download the current graph view as PNG.
- Use report buttons to quickly select related counters.
- Open **User Manual** from the Dataset section for guided usage.

## Notes

- The CSV parser assumes each record is on a single line (typical for PDH/Perfmon CSV exports).
- For very large files, repeated zooms re-scan a time window to keep memory usage low.
