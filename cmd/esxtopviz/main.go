package main

import (
	"bufio"
	"bytes"
	"embed"
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web/*
var webFS embed.FS

type IndexEntry struct {
	Row    int64
	Offset int64
	Time   time.Time
}

type DataFile struct {
	Path            string
	Label           string
	OwnedTemp       bool
	Columns         []string
	Index           []IndexEntry
	Rows            int64
	StartTime       time.Time
	EndTime         time.Time
	DataStartOffset int64
	TimeLayout      string
}

type AppState struct {
	mu sync.RWMutex
	df *DataFile
}

func (s *AppState) Get() *DataFile {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.df
}

func (s *AppState) Replace(df *DataFile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.df = df
}

const (
	indexStride = int64(1000)
)

var timeLayouts = []string{
	"01/02/2006 15:04:05",
	"01/02/2006 15:04:05.000",
	"2006-01-02 15:04:05",
	"2006-01-02 15:04:05.000",
	time.RFC3339,
	time.RFC3339Nano,
}

func parseTimeValue(s string) (time.Time, string, error) {
	s = strings.TrimSpace(s)
	for _, layout := range timeLayouts {
		if t, err := time.ParseInLocation(layout, s, time.UTC); err == nil {
			return t, layout, nil
		}
	}
	return time.Time{}, "", fmt.Errorf("unrecognized time format: %q", s)
}

func readCSVLine(line []byte) ([]string, error) {
	line = bytes.TrimRight(line, "\r\n")
	r := csv.NewReader(bytes.NewReader(line))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	record, err := r.Read()
	if err != nil {
		return nil, err
	}
	return record, nil
}

func buildIndex(path string) (*DataFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	reader := bufio.NewReaderSize(f, 4*1024*1024)
	var offset int64

	line, err := reader.ReadBytes('\n')
	if err != nil {
		if !errors.Is(err, io.EOF) {
			return nil, err
		}
		if len(line) == 0 {
			return nil, fmt.Errorf("empty file")
		}
	}
	offset += int64(len(line))
	header, err := readCSVLine(line)
	if err != nil {
		return nil, fmt.Errorf("failed to parse header: %w", err)
	}
	if len(header) == 0 {
		return nil, fmt.Errorf("empty header")
	}
	header[0] = "Time"

	df := &DataFile{
		Path:            path,
		Label:           path,
		Columns:         header,
		DataStartOffset: offset,
		Index:           make([]IndexEntry, 0, 1024),
	}

	var row int64
	for {
		line, err = reader.ReadBytes('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		if len(line) == 0 && errors.Is(err, io.EOF) {
			break
		}

		record, perr := readCSVLine(line)
		if perr != nil || len(record) == 0 {
			offset += int64(len(line))
			if errors.Is(err, io.EOF) {
				break
			}
			continue
		}

		row++
		timestamp, layout, terr := parseTimeValue(record[0])
		if terr == nil {
			if df.TimeLayout == "" {
				df.TimeLayout = layout
			}
			if row == 1 {
				df.StartTime = timestamp
			}
			df.EndTime = timestamp
		}

		if row == 1 || row%indexStride == 0 {
			if terr == nil {
				df.Index = append(df.Index, IndexEntry{Row: row, Offset: offset, Time: timestamp})
			}
		}

		offset += int64(len(line))
		if errors.Is(err, io.EOF) {
			break
		}
	}

	df.Rows = row
	if df.TimeLayout == "" {
		df.TimeLayout = timeLayouts[0]
	}
	return df, nil
}

func (df *DataFile) findOffset(t time.Time) (int64, int64) {
	if len(df.Index) == 0 || t.IsZero() {
		return df.DataStartOffset, 1
	}
	idx := sort.Search(len(df.Index), func(i int) bool {
		return !df.Index[i].Time.Before(t)
	})
	if idx <= 0 {
		return df.DataStartOffset, 1
	}
	entry := df.Index[idx-1]
	return entry.Offset, entry.Row
}

func (df *DataFile) estimateRows(start, end time.Time) int64 {
	if len(df.Index) < 2 {
		return df.Rows
	}
	if start.IsZero() && end.IsZero() {
		return df.Rows
	}

	var startRow int64 = 1
	var endRow int64 = df.Rows

	if !start.IsZero() {
		idx := sort.Search(len(df.Index), func(i int) bool {
			return !df.Index[i].Time.Before(start)
		})
		if idx > 0 {
			startRow = df.Index[idx-1].Row
		}
	}
	if !end.IsZero() {
		idx := sort.Search(len(df.Index), func(i int) bool {
			return !df.Index[i].Time.Before(end)
		})
		if idx > 0 {
			endRow = df.Index[idx-1].Row
		}
	}
	if endRow < startRow {
		return 0
	}
	return endRow - startRow + 1
}

func parseFloatValue(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return math.NaN(), false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return math.NaN(), false
	}
	return v, true
}

type SeriesResponse struct {
	Times  []int64         `json:"times"`
	Series []SeriesPayload `json:"series"`
	Start  int64           `json:"start"`
	End    int64           `json:"end"`
	Rows   int64           `json:"rows"`
	Error  string          `json:"error,omitempty"`
}

type SeriesPayload struct {
	Name   string    `json:"name"`
	Values []float64 `json:"values"`
}

func (df *DataFile) extractSeries(cols []int, start, end time.Time, maxPoints int) (SeriesResponse, error) {
	resp := SeriesResponse{
		Series: make([]SeriesPayload, len(cols)),
	}
	for i, idx := range cols {
		name := ""
		if idx >= 0 && idx < len(df.Columns) {
			name = df.Columns[idx]
		}
		resp.Series[i] = SeriesPayload{Name: name}
	}

	estimated := df.estimateRows(start, end)
	step := int64(1)
	if maxPoints > 0 && estimated > int64(maxPoints) {
		step = estimated / int64(maxPoints)
		if step < 1 {
			step = 1
		}
	}

	f, err := os.Open(df.Path)
	if err != nil {
		return resp, err
	}
	defer f.Close()

	startOffset, startRow := df.findOffset(start)
	if _, err := f.Seek(startOffset, io.SeekStart); err != nil {
		return resp, err
	}

	reader := bufio.NewReaderSize(f, 4*1024*1024)
	row := startRow
	var kept int64
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return resp, err
		}
		if len(line) == 0 && errors.Is(err, io.EOF) {
			break
		}

		record, perr := readCSVLine(line)
		if perr != nil || len(record) == 0 {
			if errors.Is(err, io.EOF) {
				break
			}
			continue
		}

		timestamp, _, terr := parseTimeValue(record[0])
		if terr != nil {
			row++
			if errors.Is(err, io.EOF) {
				break
			}
			continue
		}

		if !start.IsZero() && timestamp.Before(start) {
			row++
			if errors.Is(err, io.EOF) {
				break
			}
			continue
		}
		if !end.IsZero() && timestamp.After(end) {
			break
		}

		if (row-startRow)%step == 0 {
			resp.Times = append(resp.Times, timestamp.UnixMilli())
			for i, idx := range cols {
				val := math.NaN()
				if idx >= 0 && idx < len(record) {
					if v, ok := parseFloatValue(record[idx]); ok {
						val = v
					}
				}
				resp.Series[i].Values = append(resp.Series[i].Values, val)
			}
			kept++
		}

		row++
		if errors.Is(err, io.EOF) {
			break
		}
	}

	if len(resp.Times) > 0 {
		resp.Start = resp.Times[0]
		resp.End = resp.Times[len(resp.Times)-1]
	}
	resp.Rows = kept
	return resp, nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(payload)
}

func guessDefaultCSV() (string, bool) {
	entries, err := os.ReadDir(".")
	if err != nil {
		return "", false
	}

	var chosen string
	var chosenTime time.Time
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := strings.ToLower(e.Name())
		if !strings.HasSuffix(name, ".csv") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if chosen == "" || info.ModTime().After(chosenTime) {
			chosen = e.Name()
			chosenTime = info.ModTime()
		}
	}
	if chosen == "" {
		return "", false
	}
	abs, err := filepath.Abs(chosen)
	if err != nil {
		return "", false
	}
	return abs, true
}

func main() {
	var filePath string
	var port int
	flag.StringVar(&filePath, "file", "", "Path to esxtop CSV file")
	flag.IntVar(&port, "port", 8080, "Port to serve on")
	flag.Parse()

	var df *DataFile
	if strings.TrimSpace(filePath) != "" {
		absPath, err := filepath.Abs(filePath)
		if err != nil {
			log.Fatal(err)
		}
		if _, err := os.Stat(absPath); err != nil {
			log.Fatalf("file not found: %s", absPath)
		}
		df, err = buildIndex(absPath)
		if err != nil {
			log.Fatalf("index build failed: %v", err)
		}
		log.Printf("loaded startup file: %s", df.Label)
	} else if guessed, ok := guessDefaultCSV(); ok {
		var err error
		df, err = buildIndex(guessed)
		if err != nil {
			log.Printf("default CSV found but indexing failed (%s): %v", guessed, err)
		} else {
			log.Printf("auto-loaded CSV: %s", df.Label)
		}
	} else {
		log.Printf("no startup CSV found; open one from UI file picker")
	}
	state := &AppState{df: df}

	mux := http.NewServeMux()

	mux.HandleFunc("/api/meta", func(w http.ResponseWriter, r *http.Request) {
		current := state.Get()
		if current == nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"columns": []string{},
				"rows":    0,
				"start":   0,
				"end":     0,
				"file":    "",
				"loaded":  false,
			})
			return
		}
		payload := map[string]any{
			"columns": current.Columns,
			"rows":    current.Rows,
			"start":   current.StartTime.UnixMilli(),
			"end":     current.EndTime.UnixMilli(),
			"file":    current.Label,
			"loaded":  true,
		}
		writeJSON(w, http.StatusOK, payload)
	})

	mux.HandleFunc("/api/open", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
			return
		}
		var req struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		req.Path = strings.TrimSpace(req.Path)
		if req.Path == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
			return
		}
		abs, err := filepath.Abs(req.Path)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
			return
		}
		if _, err := os.Stat(abs); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file not found"})
			return
		}
		newDF, err := buildIndex(abs)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("index build failed: %v", err)})
			return
		}
		newDF.Label = abs
		state.Replace(newDF)
		writeJSON(w, http.StatusOK, map[string]any{
			"file":  newDF.Label,
			"rows":  newDF.Rows,
			"start": newDF.StartTime.UnixMilli(),
			"end":   newDF.EndTime.UnixMilli(),
		})
	})

	mux.HandleFunc("/api/upload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file is required"})
			return
		}
		defer file.Close()

		tmp, err := os.CreateTemp("", "esxtopviz-*.csv")
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create temp file"})
			return
		}
		tmpPath := tmp.Name()
		if _, err := io.Copy(tmp, file); err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmpPath)
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to save uploaded file"})
			return
		}
		if err := tmp.Close(); err != nil {
			_ = os.Remove(tmpPath)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to finalize uploaded file"})
			return
		}

		newDF, err := buildIndex(tmpPath)
		if err != nil {
			_ = os.Remove(tmpPath)
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("index build failed: %v", err)})
			return
		}
		newDF.OwnedTemp = true
		if strings.TrimSpace(header.Filename) != "" {
			newDF.Label = header.Filename
		} else {
			newDF.Label = filepath.Base(tmpPath)
		}

		state.Replace(newDF)
		writeJSON(w, http.StatusOK, map[string]any{
			"file":  newDF.Label,
			"rows":  newDF.Rows,
			"start": newDF.StartTime.UnixMilli(),
			"end":   newDF.EndTime.UnixMilli(),
		})
	})

	mux.HandleFunc("/api/series", func(w http.ResponseWriter, r *http.Request) {
		colsParam := r.URL.Query()["col"]
		if len(colsParam) == 0 {
			colsParam = strings.Split(r.URL.Query().Get("cols"), ",")
		}
		cols := make([]int, 0, len(colsParam))
		for _, raw := range colsParam {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				continue
			}
			idx, err := strconv.Atoi(raw)
			if err != nil {
				continue
			}
			cols = append(cols, idx)
		}
		if len(cols) == 0 {
			writeJSON(w, http.StatusBadRequest, SeriesResponse{Error: "no columns selected"})
			return
		}
		current := state.Get()
		if current == nil {
			writeJSON(w, http.StatusInternalServerError, SeriesResponse{Error: "no file loaded"})
			return
		}

		parseTimeParam := func(key string) time.Time {
			val := strings.TrimSpace(r.URL.Query().Get(key))
			if val == "" {
				return time.Time{}
			}
			if ms, err := strconv.ParseInt(val, 10, 64); err == nil {
				return time.UnixMilli(ms).UTC()
			}
			t, _, _ := parseTimeValue(val)
			return t
		}

		start := parseTimeParam("start")
		end := parseTimeParam("end")
		maxPoints := 0
		if mp := r.URL.Query().Get("maxPoints"); mp != "" {
			if v, err := strconv.Atoi(mp); err == nil {
				maxPoints = v
			}
		}

		resp, err := current.extractSeries(cols, start, end, maxPoints)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, SeriesResponse{Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, resp)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		data, err := webFS.ReadFile("web/index.html")
		if err != nil {
			http.Error(w, "index not found", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
	})

	mux.HandleFunc("/manual", func(w http.ResponseWriter, r *http.Request) {
		data, err := webFS.ReadFile("web/manual.html")
		if err != nil {
			http.Error(w, "manual not found", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
	})

	mux.HandleFunc("/manual.html", func(w http.ResponseWriter, r *http.Request) {
		data, err := webFS.ReadFile("web/manual.html")
		if err != nil {
			http.Error(w, "manual not found", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
	})

	mux.HandleFunc("/app.js", func(w http.ResponseWriter, r *http.Request) {
		data, err := webFS.ReadFile("web/app.js")
		if err != nil {
			http.Error(w, "app.js not found", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = w.Write(data)
	})

	mux.HandleFunc("/styles.css", func(w http.ResponseWriter, r *http.Request) {
		data, err := webFS.ReadFile("web/styles.css")
		if err != nil {
			http.Error(w, "styles.css not found", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		_, _ = w.Write(data)
	})

	addr := fmt.Sprintf(":%d", port)
	log.Printf("esxtopviz listening on %s", addr)
	log.Printf("open: http://localhost:%d", port)
	if current := state.Get(); current != nil {
		log.Printf("file: %s", current.Label)
	}
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
