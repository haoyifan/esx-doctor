<p align="center">
  <img src="icon/icon.png" alt="esx-doctor logo" width="120" />
</p>

<h1 align="center">esx-doctor</h1>

<p align="center">Fast, local-first troubleshooting for large esxtop CSV files.</p>

`esx-doctor` is built for one job: help you move from a huge batch CSV to a clear performance story quickly.
You load a file, pick one metric, compare instances, zoom around the timeline, and use diagnostics templates to surface likely problems.

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

Built-in templates live in `cmd/esx-doctor/templates` and run only when you click `Run Diagnostics`.
A template is a small JSON rule file.

Example:

```json
{
  "id": "cpu.high_ready.v1",
  "name": "High Ready Time",
  "description": "Detect sustained vCPU ready time above threshold.",
  "enabled": true,
  "severity": "high",
  "detector": {
    "type": "high_ready",
    "threshold": 5.0,
    "min_consecutive": 6,
    "include_attribute_equals": ["Vcpu: % Ready"],
    "exclude_instance_regex": ["\\bidle\\d+\\b"]
  }
}
```

Supported top-level fields:
- `id`: unique template ID
- `name`: display name in UI and findings
- `description`: what the rule looks for
- `enabled`: default selected state
- `severity`: `critical` | `high` | `medium` | `low`
- `detector`: detector configuration object

Supported detector fields:
- `type`
- `threshold`
- `comparison` (`less` for low-side checks; default is greater-than)
- `min_consecutive`
- `min_switches`
- `min_gap`
- `high_threshold`, `low_threshold`
- `include_attribute_equals`
- `include_object_equals`
- `exclude_instance_contains`
- `exclude_instance_regex`

Current detector types include:
- `high_ready`
- `high_costop`
- `exclusive_affinity`
- `numa_zigzag`
- `low_numa_local`
- `memory_overcommit_high`
- `numa_imbalance`
- `network_outbound_drop_high`
- `disk_adapter_failed_reads_high`
- `disk_adapter_driver_latency_high`

## User manual

In-app button: `User Manual`

Direct URL:
- `http://localhost:8080/manual`

## License recommendation

Recommended: **Apache-2.0**.

Why this is a good fit:
- Permissive (easy internal/company adoption)
- Includes an explicit patent grant (important for enterprise environments)
- Clear obligations (keep notices, include license text)

If you want the shortest/most permissive text with fewer explicit protections, MIT is also fine.

## Troubleshooting

- No graph lines: select at least one instance and click `Load`.
- Timeline looks short: verify the CSV time range itself.
- Diagnostics points to unexpected data: inspect the template's `include_*` and `exclude_*` filters.
