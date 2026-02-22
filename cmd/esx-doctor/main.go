package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web/* templates/*.json
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

type Session struct {
	mu       sync.RWMutex
	df       *DataFile
	lastSeen time.Time
}

func (s *Session) Get() *DataFile {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.df
}

func (s *Session) Touch(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSeen = now
}

func (s *Session) LastSeen() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastSeen
}

func (s *Session) Replace(df *DataFile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.df
	s.df = df
	if old != nil && old.OwnedTemp && old.Path != "" && (df == nil || old.Path != df.Path) {
		_ = os.Remove(old.Path)
	}
}

func (s *Session) Close() {
	s.Replace(nil)
}

type SessionStore struct {
	mu         sync.RWMutex
	sessions   map[string]*Session
	defaultDF  *DataFile
	ttl        time.Duration
	cookieName string
}

func NewSessionStore(defaultDF *DataFile, ttl time.Duration) *SessionStore {
	return &SessionStore{
		sessions:   make(map[string]*Session),
		defaultDF:  defaultDF,
		ttl:        ttl,
		cookieName: "esx_doctor_sid",
	}
}

func randomSessionID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("sid-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func (s *SessionStore) getSessionIDFromRequest(r *http.Request) string {
	if h := strings.TrimSpace(r.Header.Get("X-ESX-Session-ID")); h != "" {
		return h
	}
	if c, err := r.Cookie(s.cookieName); err == nil {
		return strings.TrimSpace(c.Value)
	}
	return ""
}

func (s *SessionStore) attachCookie(w http.ResponseWriter, id string) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName,
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int((24 * time.Hour).Seconds()),
	})
}

func (s *SessionStore) SessionForRequest(w http.ResponseWriter, r *http.Request) *Session {
	id := s.getSessionIDFromRequest(r)
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()

	if id == "" {
		id = randomSessionID()
	}
	sess, ok := s.sessions[id]
	if !ok {
		sess = &Session{df: s.defaultDF, lastSeen: now}
		s.sessions[id] = sess
	} else {
		sess.lastSeen = now
	}
	s.attachCookie(w, id)
	return sess
}

func (s *SessionStore) CleanupExpired() {
	now := time.Now()
	var expired []*Session

	s.mu.Lock()
	for id, sess := range s.sessions {
		if now.Sub(sess.LastSeen()) > s.ttl {
			delete(s.sessions, id)
			expired = append(expired, sess)
		}
	}
	s.mu.Unlock()

	for _, sess := range expired {
		sess.Close()
	}
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

func parseDelimitedFloatValues(s string, delim string) ([]float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, false
	}
	parts := strings.Split(s, delim)
	if len(parts) < 2 {
		return nil, false
	}
	out := make([]float64, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			return nil, false
		}
		v, err := strconv.ParseFloat(p, 64)
		if err != nil {
			return nil, false
		}
		out = append(out, v)
	}
	return out, true
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
		Series: make([]SeriesPayload, 0, len(cols)),
	}
	seriesMap := make([][]int, len(cols))
	validCounts := make([]int, 0, len(cols))
	for i, idx := range cols {
		name := ""
		if idx >= 0 && idx < len(df.Columns) {
			name = df.Columns[idx]
		}
		resp.Series = append(resp.Series, SeriesPayload{Name: name})
		seriesMap[i] = []int{len(resp.Series) - 1}
		validCounts = append(validCounts, 0)
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
			currentPos := len(resp.Times) - 1
			for si := range resp.Series {
				resp.Series[si].Values = append(resp.Series[si].Values, 0)
			}

			for i, idx := range cols {
				targets := seriesMap[i]
				if idx >= 0 && idx < len(record) {
					raw := record[idx]
					if values, ok := parseDelimitedFloatValues(raw, "/"); ok {
						if len(targets) == 1 && len(values) > 1 {
							resp.Series[targets[0]].Name = fmt.Sprintf("%s [home 1]", resp.Series[targets[0]].Name)
						}
						for len(targets) < len(values) {
							nextHome := len(targets) + 1
							name := ""
							if len(targets) > 0 {
								base := resp.Series[targets[0]].Name
								if p := strings.LastIndex(base, " [home "); p > 0 {
									base = base[:p]
								}
								name = fmt.Sprintf("%s [home %d]", base, nextHome)
							}
							if name == "" {
								name = fmt.Sprintf("col_%d [home %d]", idx, nextHome)
							}
							sp := SeriesPayload{Name: name, Values: make([]float64, currentPos+1)}
							for x := 0; x <= currentPos; x++ {
								sp.Values[x] = 0
							}
							resp.Series = append(resp.Series, sp)
							targets = append(targets, len(resp.Series)-1)
							validCounts = append(validCounts, 0)
						}
						seriesMap[i] = targets
						for vi, val := range values {
							resp.Series[targets[vi]].Values[currentPos] = val
							validCounts[targets[vi]]++
						}
						continue
					}
					if v, ok := parseFloatValue(raw); ok {
						resp.Series[targets[0]].Values[currentPos] = v
						validCounts[targets[0]]++
					}
				}
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
	filtered := make([]SeriesPayload, 0, len(resp.Series))
	for i, s := range resp.Series {
		if i < len(validCounts) && validCounts[i] > 0 {
			filtered = append(filtered, s)
		}
	}
	resp.Series = filtered
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

func indexUploadedOrFetchedCSV(reader io.Reader, label, prefix string) (*DataFile, error) {
	tmp, err := os.CreateTemp("", prefix)
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	if _, err := io.Copy(tmp, reader); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return nil, fmt.Errorf("failed to write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return nil, fmt.Errorf("failed to finalize temp file: %w", err)
	}

	newDF, err := buildIndex(tmpPath)
	if err != nil {
		_ = os.Remove(tmpPath)
		return nil, err
	}
	newDF.OwnedTemp = true
	if strings.TrimSpace(label) != "" {
		newDF.Label = label
	} else {
		newDF.Label = filepath.Base(tmpPath)
	}
	return newDF, nil
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
	flag.StringVar(&filePath, "file", "", "Path to ESX CSV file")
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
	sessions := NewSessionStore(df, 24*time.Hour)
	go func() {
		ticker := time.NewTicker(30 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			sessions.CleanupExpired()
		}
	}()
	templates, err := loadDiagnosticTemplates(webFS)
	if err != nil {
		log.Fatalf("failed to load diagnostic templates: %v", err)
	}
	templateByID := make(map[string]DiagnosticTemplate, len(templates))
	templateMeta := make([]DiagnosticTemplateMeta, 0, len(templates))
	for _, t := range templates {
		templateByID[t.ID] = t
		templateMeta = append(templateMeta, DiagnosticTemplateMeta{
			ID:          t.ID,
			Name:        t.Name,
			Description: t.Description,
			Enabled:     t.Enabled,
			Severity:    t.Severity,
		})
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/api/meta", func(w http.ResponseWriter, r *http.Request) {
		current := sessions.SessionForRequest(w, r).Get()
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

	mux.HandleFunc("/api/diagnostics/templates", func(w http.ResponseWriter, r *http.Request) {
		_ = sessions.SessionForRequest(w, r)
		writeJSON(w, http.StatusOK, map[string]any{
			"templates": templateMeta,
		})
	})

	mux.HandleFunc("/api/diagnostics/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
			return
		}
		current := sessions.SessionForRequest(w, r).Get()
		if current == nil {
			writeJSON(w, http.StatusBadRequest, DiagnosticRunResponse{Error: "no file loaded"})
			return
		}
		var req struct {
			TemplateIDs []string `json:"templateIds"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, DiagnosticRunResponse{Error: "invalid JSON body"})
			return
		}
		selected := make([]DiagnosticTemplate, 0)
		if len(req.TemplateIDs) == 0 {
			for _, t := range templates {
				if t.Enabled {
					selected = append(selected, t)
				}
			}
		} else {
			for _, id := range req.TemplateIDs {
				id = strings.TrimSpace(id)
				if id == "" {
					continue
				}
				if t, ok := templateByID[id]; ok {
					selected = append(selected, t)
				}
			}
		}
		resp, err := runDiagnostics(current, selected)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, DiagnosticRunResponse{Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, resp)
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
		sessions.SessionForRequest(w, r).Replace(newDF)
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

		newDF, err := indexUploadedOrFetchedCSV(file, strings.TrimSpace(header.Filename), "esx-doctor-upload-*.csv")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("index build failed: %v", err)})
			return
		}

		sessions.SessionForRequest(w, r).Replace(newDF)
		writeJSON(w, http.StatusOK, map[string]any{
			"file":  newDF.Label,
			"rows":  newDF.Rows,
			"start": newDF.StartTime.UnixMilli(),
			"end":   newDF.EndTime.UnixMilli(),
		})
	})

	mux.HandleFunc("/api/open-url", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
			return
		}
		var req struct {
			URL string `json:"url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		raw := strings.TrimSpace(req.URL)
		if raw == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "url is required"})
			return
		}
		parsed, err := neturl.Parse(raw)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid URL"})
			return
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "URL must use http or https"})
			return
		}

		client := &http.Client{
			Timeout: 60 * time.Second,
			Transport: &http.Transport{
				DialContext: (&net.Dialer{
					Timeout: 10 * time.Second,
				}).DialContext,
				TLSHandshakeTimeout: 10 * time.Second,
			},
		}
		resp, err := client.Get(raw)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": fmt.Sprintf("failed to fetch URL: %v", err)})
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": fmt.Sprintf("URL returned status %d", resp.StatusCode)})
			return
		}

		label := raw
		if parsed.Path != "" {
			if base := filepath.Base(parsed.Path); base != "." && base != "/" {
				label = base
			}
		}
		newDF, err := indexUploadedOrFetchedCSV(resp.Body, label, "esx-doctor-url-*.csv")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid CSV from URL: %v", err)})
			return
		}

		sessions.SessionForRequest(w, r).Replace(newDF)
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
		current := sessions.SessionForRequest(w, r).Get()
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

	mux.HandleFunc("/icon.png", func(w http.ResponseWriter, r *http.Request) {
		data, err := webFS.ReadFile("web/icon.png")
		if err != nil {
			http.Error(w, "icon.png not found", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(data)
	})
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		data, err := webFS.ReadFile("web/icon.png")
		if err != nil {
			http.Error(w, "favicon not found", http.StatusInternalServerError)
			return
		}
		// Serve the project PNG as a universal favicon fallback.
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(data)
	})

	addr := fmt.Sprintf(":%d", port)
	log.Printf("esx-doctor listening on %s", addr)
	log.Printf("open: http://localhost:%d", port)
	if current := df; current != nil {
		log.Printf("file: %s", current.Label)
	}
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
