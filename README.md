<p align="center">
  <img src="icon/icon.png" alt="esx-doctor logo" width="120" />
</p>

<h1 align="center">esx-doctor</h1>

<p align="center">High-performance visualization for large esxtop CSV exports.</p>

`esx-doctor` is a high-performance viewer for large ESX/esxtop batch CSV exports.
It is designed for fast startup, low memory usage, and interactive time-series troubleshooting.

## Why esx-doctor

- Minimal dependency footprint: if Go is installed, it runs on Linux, macOS, and Windows with no extra runtime stack. 🧩
- Fast and resource-efficient: Go backend is optimized for large CSV ingestion and interactive querying. ⚡
- Easy local deployment: run directly with `go run .` or build one binary and start it anywhere. 🚀
- Easy to use: focused workflow that does one thing well—investigate esxtop batch metrics quickly. 🎯

## Quick Start

From project root:

```bash
go run .
```

The app prints the URL, for example:

```text
open: http://localhost:8080
```

Then open that URL in your browser.

Startup behavior:
- If `-file` is provided, that CSV is loaded immediately.
- If `-file` is omitted, `esx-doctor` auto-loads the newest `*.csv` in current directory.
- If no CSV exists in current directory, use the UI file picker (`Open Selected CSV`).

## Run Options

```bash
go run . -port 8080
```

```bash
go run . -file /path/to/esx.csv -port 8080
```

## Build Binary

```bash
go build -o esx-doctor ./cmd/esx-doctor
./esx-doctor -port 8080
```

Windows:

```bash
go build -o esx-doctor.exe ./cmd/esx-doctor
```

## Deployment Guide

### Option A: Direct run (Linux/macOS/Windows)
1. Install Go 1.22+
2. Copy repo to host
3. Run `go run . -port 8080`
4. Open `http://<host>:8080`

### Option B: Single binary deployment
1. Build binary on target OS/arch
2. Copy binary to target host
3. Run with optional flags:

```bash
./esx-doctor -port 8080 -file /data/host-esx.csv
```

### Option C: Linux systemd service
Create `/etc/systemd/system/esx-doctor.service`:

```ini
[Unit]
Description=esx-doctor CSV Viewer
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/esx-doctor
ExecStart=/opt/esx-doctor/esx-doctor -port 8080
Restart=on-failure
User=nobody
Group=nogroup

[Install]
WantedBy=multi-user.target
```

Enable service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now esx-doctor
sudo systemctl status esx-doctor
```

## User Manual

In app:
- `Dataset` -> `User Manual`

Direct URL:
- `http://localhost:8080/manual`

## Typical Workflow

1. Open CSV via file picker.
   Alternatively paste an HTTP/HTTPS CSV URL and click `Open CSV from URL`.
2. Select report category.
3. Select one attribute.
4. Select one or more instances.
5. Click `Load`.
6. Drag on chart to zoom in.
7. Double-click chart or click `Reset Zoom` to zoom out.
8. Use bottom slider to pan current zoom window.
9. Click `Screenshot` to export the current view.
10. Use `New Window` to create parallel analysis windows (for example `% Used` and `% Ready`) and switch via window tabs.

## Features

- Dynamic report groups (CPU, Memory, NUMA, Power, vSAN, Storage, Network, etc.)
- Single-attribute, multi-instance overlays for clear comparison
- Template-based diagnostics (`Run Diagnostics`) to surface potential issues quickly
- Tooltip values sorted descending
- Compact tooltip labels (instance-focused names)
- Zoom + pan slider navigation
- Screenshot export with graph title and visible time window
- Runtime CSV switching without restart
- Multi-window workspace with independent selections and zoom states
- Per-session CSV isolation for concurrent users/tabs

## Diagnostics Templates

- Built-in templates live in `cmd/esx-doctor/templates`.
- You can select templates in the UI diagnostics panel and run them on demand.
- Templates can exclude noisy instances by name using `detector.exclude_instance_contains`.
- Current starter templates include:
  - Aggressive NUMA migration pattern
  - High ready time
  - High co-stop time
  - Sustained storage latency
  - Exclusive affinity enabled

## Troubleshooting

- No graph lines: select at least one instance and click `Load Graph`.
- Short timeline: verify CSV itself spans wider timestamps.
- App starts with no data: load CSV from file picker.
