# HyperScope

HyperScope is a high-performance viewer for large `esxtop` / PDH CSV files.
It is optimized for low-memory reads, interactive charting, and large multi-counter datasets.

## Quick Start

From project root:

```bash
go run .
```

The app starts and prints the URL (for example `http://localhost:8080`).

Notes:
- If you pass `-file`, that CSV is loaded immediately.
- If you do not pass `-file`, HyperScope auto-loads the newest `*.csv` in the current directory.
- If no CSV exists in current directory, open one from the UI file picker.

## Run Options

```bash
go run . -port 8080
```

```bash
go run . -file /path/to/esxtop.csv -port 8080
```

## Build Binary

```bash
go build -o hyperscope ./cmd/esxtopviz
./hyperscope -port 8080
```

## Deployment Guide

### Option A: Run directly (Linux/Windows/macOS)
- Install Go 1.22+
- Copy repo folder to target host
- Run `go run . -port 8080`
- Access `http://<host>:8080`

### Option B: Ship single binary
- Build once on target OS/arch:
  - Linux: `go build -o hyperscope ./cmd/esxtopviz`
  - Windows: `go build -o hyperscope.exe ./cmd/esxtopviz`
- Run binary with desired port/file flags.

### Option C: systemd service (Linux)
Create `/etc/systemd/system/hyperscope.service`:

```ini
[Unit]
Description=HyperScope CSV Viewer
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/hyperscope
ExecStart=/opt/hyperscope/hyperscope -port 8080
Restart=on-failure
User=nobody
Group=nogroup

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hyperscope
sudo systemctl status hyperscope
```

## User Manual

Open from UI:
- `Dataset` section -> `User Manual`

Or directly:
- `http://localhost:8080/manual`

Core workflow:
1. Select CSV file and click `Open Selected CSV`.
2. Pick a report category.
3. Pick one attribute and one/more instances.
4. Click `Load Graph`.
5. Drag on chart to zoom in.
6. Double-click chart or click `Zoom Out` to zoom out.
7. Use bottom slider when zoomed to pan across time.
8. Click `Screenshot` to download current chart image.

## Features

- Dynamic report categories (CPU, Memory, NUMA, Power, vSAN, etc.)
- Single-attribute multi-instance plotting for cleaner comparisons
- Hover tooltip sorted by highest value first
- Zoom, pan slider, and screenshot export
- Runtime CSV switching without restart

## Troubleshooting

- If no chart is drawn, ensure at least one instance is selected and click `Load Graph`.
- If timeline looks short, verify CSV itself contains wider timestamps.
- If app starts with no data, load CSV through file picker.
