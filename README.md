<p align="center">
  <img src="icon/icon.png" alt="esx-doctor logo" width="120" />
</p>

<h1 align="center">esx-doctor</h1>

<p align="center">Fast, local-first troubleshooting for large esxtop CSV files.</p>

`esx-doctor` is built for one job: help you move from a huge batch CSV to a clear performance story quickly.
You load a file, pick one metric, compare instances, zoom around the timeline, and use diagnostics templates to surface likely problems.

## Disclaimer

This is a personal side project created on personal time. It is not an official VMware product,
is not endorsed by VMware, and does not represent VMware product commitments or support.

## Why this tool exists

When esxtop data is large, most of the time goes to searching, filtering, and correlating across metrics.
`esx-doctor` keeps that loop tight:

- Runs anywhere Go runs: Linux, macOS, Windows.
- No heavyweight runtime stack.
- Handles large CSVs with a Go backend optimized for streaming and low memory pressure.
- Keeps analysis local by default (good for sensitive environments).

## Quick start

From the project root:

```bash
go run .
```

The app prints a URL like:

```text
open: http://localhost:8080
```

Open that URL in your browser.

## Common run options

```bash
go run . -port 8080
```

```bash
go run . -file /path/to/esxtop.csv -port 8080
```

Startup behavior:
- If `-file` is provided, that CSV is loaded immediately.
- If `-file` is omitted, esx-doctor auto-loads the newest `*.csv` in the current directory.
- If no CSV is found, use the UI file picker or URL loader.

## Build a binary

```bash
go build -o esx-doctor ./cmd/esx-doctor
./esx-doctor -port 8080
```

Windows:

```bash
go build -o esx-doctor.exe ./cmd/esx-doctor
```

## Deployment notes

### Option A: direct run
1. Install Go 1.22+
2. Clone/copy repo to host
3. Run `go run . -port 8080`
4. Open `http://<host>:8080`

### Option B: single binary
1. Build for target OS/arch
2. Copy binary to host
3. Run `./esx-doctor -port 8080 -file /data/esxtop.csv`

### Option C: systemd (Linux)
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

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now esx-doctor
sudo systemctl status esx-doctor
```

## Workflow in practice

1. Open a local CSV or URL.
2. Pick a report family (CPU, Memory, NUMA, Network, Storage, Power, vSAN, Other).
3. Pick one attribute (single-metric view keeps comparisons clean).
4. Pick one or more instances.
5. Click `Load`.
6. Zoom, pan, hover, and mark events.
7. Use `New Window` to compare related metrics side-by-side by tabs.

## Features

- Single-attribute plotting with multi-instance overlay
- Large CSV support with responsive querying
- Local file and URL ingestion
- Zoom + pan timeline controls
- Crosshair, sorted tooltip, and compact instance labels
- Marks shared across windows for timestamp correlation
- Screenshot export of current chart view
- Multi-window workspace for parallel analysis
- Session isolation so multiple users/tabs can work on different CSVs concurrently
- On-demand diagnostics with pluggable templates

## Diagnostics templates

The core idea is simple: troubleshooting should not depend on one person knowing exactly where to look.

In real incidents, one engineer may start from storage, another from CPU, another from memory. Important signals can be missed if you only scan the area you already know well. Diagnostics templates add a layer of built-in intelligence that scans across reports and surfaces likely issues quickly.

How it helps:
- Finds suspicious patterns across multiple domains (CPU, memory, NUMA, network, storage) in one pass
- Highlights concrete findings with timestamps and triggering instances
- Lets you click `Open` to jump directly to the relevant chart for validation
- Stays extensible: when your team discovers a new failure pattern, you can codify it as a new template and reuse it

Templates are JSON files in `cmd/esx-doctor/templates` and run on demand when you click `Run Diagnostics`.
For full template format, field reference, and examples, see the User Manual (`/manual`).

## User manual

In-app button: `User Manual`

Direct URL:
- `http://localhost:8080/manual`

## Troubleshooting

- No graph lines: select at least one instance and click `Load`.
- Timeline looks short: verify the CSV time range itself.
- Diagnostics points to unexpected data: inspect the template's `include_*` and `exclude_*` filters.
