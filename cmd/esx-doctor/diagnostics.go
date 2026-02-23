package main

import (
	"bufio"
	"bytes"
	"embed"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type DiagnosticTemplate struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Enabled     bool             `json:"enabled"`
	Severity    string           `json:"severity"`
	Detector    DetectorTemplate `json:"detector"`
}

type DetectorTemplate struct {
	Type                    string         `json:"type"`
	Threshold               float64        `json:"threshold,omitempty"`
	Comparison              string         `json:"comparison,omitempty"`
	MinConsecutive          int            `json:"min_consecutive,omitempty"`
	MinSwitches             int            `json:"min_switches,omitempty"`
	MinGap                  float64        `json:"min_gap,omitempty"`
	LowThreshold            float64        `json:"low_threshold,omitempty"`
	HighThreshold           float64        `json:"high_threshold,omitempty"`
	IncludeAttributeEquals  []string       `json:"include_attribute_equals,omitempty"`
	IncludeObjectEquals     []string       `json:"include_object_equals,omitempty"`
	ExcludeInstanceContains []string       `json:"exclude_instance_contains,omitempty"`
	ExcludeInstanceRegex    []string       `json:"exclude_instance_regex,omitempty"`
	Filter                  TemplateFilter `json:"filter,omitempty"`
}

type TemplateFilter struct {
	Logic      string              `json:"logic,omitempty"`
	Conditions []TemplateCondition `json:"conditions,omitempty"`
}

type TemplateCondition struct {
	Field string `json:"field"`
	Op    string `json:"op"`
	Value string `json:"value"`
}

type DiagnosticTemplateMeta struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	Severity    string `json:"severity"`
}

type DiagnosticFinding struct {
	TemplateID     string   `json:"templateId"`
	TemplateName   string   `json:"templateName"`
	Title          string   `json:"title"`
	Severity       string   `json:"severity"`
	ReportKey      string   `json:"reportKey"`
	AttributeLabel string   `json:"attributeLabel,omitempty"`
	Instances      []string `json:"instances,omitempty"`
	Start          int64    `json:"start,omitempty"`
	End            int64    `json:"end,omitempty"`
	Summary        string   `json:"summary"`
}

type DiagnosticRunResponse struct {
	Findings    []DiagnosticFinding `json:"findings"`
	Templates   int                 `json:"templates"`
	RowsScanned int64               `json:"rowsScanned"`
	DurationMs  int64               `json:"durationMs"`
	Error       string              `json:"error,omitempty"`
}

type parsedColumn struct {
	Idx            int
	Raw            string
	Object         string
	Instance       string
	Counter        string
	AttributeLabel string
}

func parsePDHColumnBackend(raw string, idx int) parsedColumn {
	fallback := parsedColumn{
		Idx:            idx,
		Raw:            raw,
		Object:         "Other",
		Instance:       "Global",
		Counter:        raw,
		AttributeLabel: raw,
	}
	if !strings.HasPrefix(raw, "\\\\") {
		return fallback
	}
	parts := strings.Split(raw, "\\")
	if len(parts) < 5 {
		return fallback
	}
	objectPart := parts[3]
	counter := strings.Join(parts[4:], "\\")
	objectBase := objectPart
	if p := strings.Index(objectPart, "("); p >= 0 {
		objectBase = objectPart[:p]
	}
	instance := "Global"
	if start := strings.Index(objectPart, "("); start >= 0 {
		if end := strings.LastIndex(objectPart, ")"); end > start {
			instance = objectPart[start+1 : end]
		}
	}
	if strings.TrimSpace(objectBase) == "" {
		objectBase = "Other"
	}
	if strings.TrimSpace(counter) == "" {
		counter = raw
	}
	return parsedColumn{
		Idx:            idx,
		Raw:            raw,
		Object:         objectBase,
		Instance:       instance,
		Counter:        counter,
		AttributeLabel: fmt.Sprintf("%s: %s", objectBase, counter),
	}
}

func readCSVLineBytes(line []byte) ([]string, error) {
	line = bytes.TrimRight(line, "\r\n")
	r := csv.NewReader(bytes.NewReader(line))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	return r.Read()
}

func loadDiagnosticTemplates(fs embed.FS) ([]DiagnosticTemplate, error) {
	entries, err := fs.ReadDir("templates")
	if err != nil {
		return nil, err
	}
	out := make([]DiagnosticTemplate, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
			continue
		}
		data, err := fs.ReadFile("templates/" + e.Name())
		if err != nil {
			return nil, err
		}
		var t DiagnosticTemplate
		if err := json.Unmarshal(data, &t); err != nil {
			return nil, fmt.Errorf("invalid template %s: %w", e.Name(), err)
		}
		if strings.TrimSpace(t.ID) == "" || strings.TrimSpace(t.Name) == "" || strings.TrimSpace(t.Detector.Type) == "" {
			return nil, fmt.Errorf("invalid template %s: missing required fields", e.Name())
		}
		if strings.TrimSpace(t.Severity) == "" {
			t.Severity = "medium"
		}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

type rowProcessor interface {
	onRow(ts time.Time, record []string)
	finalize() []DiagnosticFinding
}

type thresholdEntityState struct {
	currLen   int
	currStart time.Time
	currPeak  float64
	bestLen   int
	bestStart time.Time
	bestEnd   time.Time
	bestPeak  float64
}

type thresholdProcessor struct {
	template       DiagnosticTemplate
	reportKey      string
	attributeLabel string
	compareLess    bool
	indexes        []int
	labels         []string
	threshold      float64
	minConsecutive int
	states         []thresholdEntityState
}

func (p *thresholdProcessor) onRow(ts time.Time, record []string) {
	for i, idx := range p.indexes {
		if idx < 0 || idx >= len(record) {
			continue
		}
		v, ok := parseFloatValue(record[idx])
		if !ok || !NumberFinite(v) {
			p.reset(i, ts)
			continue
		}
		matched := v > p.threshold
		if p.compareLess {
			matched = v < p.threshold
		}
		if matched {
			s := &p.states[i]
			if s.currLen == 0 {
				s.currStart = ts
				s.currPeak = v
			} else if (!p.compareLess && v > s.currPeak) || (p.compareLess && v < s.currPeak) {
				s.currPeak = v
			}
			s.currLen++
			continue
		}
		p.reset(i, ts)
	}
}

func (p *thresholdProcessor) reset(i int, ts time.Time) {
	s := &p.states[i]
	if s.currLen > s.bestLen {
		s.bestLen = s.currLen
		s.bestStart = s.currStart
		s.bestEnd = ts
		s.bestPeak = s.currPeak
	}
	s.currLen = 0
	s.currPeak = 0
}

func (p *thresholdProcessor) finalize() []DiagnosticFinding {
	for i := range p.states {
		// finalize open streaks
		p.reset(i, time.Time{})
	}
	findings := make([]DiagnosticFinding, 0, len(p.states))
	for i, s := range p.states {
		if s.bestLen < p.minConsecutive {
			continue
		}
		compWord := "above"
		if p.compareLess {
			compWord = "below"
		}
		summary := fmt.Sprintf("Sustained threshold breach: peak %.2f stayed %s threshold %.2f for %d consecutive samples.", s.bestPeak, compWord, p.threshold, s.bestLen)
		f := DiagnosticFinding{
			TemplateID:     p.template.ID,
			TemplateName:   p.template.Name,
			Title:          p.template.Name,
			Severity:       p.template.Severity,
			ReportKey:      p.reportKey,
			AttributeLabel: p.attributeLabel,
			Instances:      []string{p.labels[i]},
			Summary:        summary,
		}
		if !s.bestStart.IsZero() {
			f.Start = s.bestStart.UnixMilli()
		}
		if !s.bestEnd.IsZero() {
			f.End = s.bestEnd.UnixMilli()
		}
		findings = append(findings, f)
	}
	if len(findings) > 20 {
		findings = findings[:20]
	}
	return findings
}

type rangeImbalanceProcessor struct {
	template       DiagnosticTemplate
	reportKey      string
	attributeLabel string
	indexes        []int
	labels         []string
	highThreshold  float64
	lowThreshold   float64
	minGap         float64
	minConsecutive int
	currLen        int
	currStart      time.Time
	currHigh       string
	currLow        string
	bestLen        int
	bestStart      time.Time
	bestEnd        time.Time
	bestHigh       string
	bestLow        string
}

func (p *rangeImbalanceProcessor) onRow(ts time.Time, record []string) {
	bestVal := -math.MaxFloat64
	minVal := math.MaxFloat64
	bestIdx := -1
	minIdx := -1
	valid := 0
	for i, idx := range p.indexes {
		if idx < 0 || idx >= len(record) {
			continue
		}
		v, ok := parseFloatValue(record[idx])
		if !ok || !NumberFinite(v) {
			continue
		}
		valid++
		if v > bestVal {
			bestVal = v
			bestIdx = i
		}
		if v < minVal {
			minVal = v
			minIdx = i
		}
	}
	if valid < 2 {
		p.reset(ts)
		return
	}
	if bestVal >= p.highThreshold && minVal <= p.lowThreshold && (bestVal-minVal) >= p.minGap {
		if p.currLen == 0 {
			p.currStart = ts
			p.currHigh = p.labels[bestIdx]
			p.currLow = p.labels[minIdx]
		}
		p.currLen++
		return
	}
	p.reset(ts)
}

func (p *rangeImbalanceProcessor) reset(ts time.Time) {
	if p.currLen > p.bestLen {
		p.bestLen = p.currLen
		p.bestStart = p.currStart
		p.bestEnd = ts
		p.bestHigh = p.currHigh
		p.bestLow = p.currLow
	}
	p.currLen = 0
	p.currHigh = ""
	p.currLow = ""
}

func (p *rangeImbalanceProcessor) finalize() []DiagnosticFinding {
	p.reset(time.Time{})
	if p.bestLen < p.minConsecutive {
		return nil
	}
	out := DiagnosticFinding{
		TemplateID:     p.template.ID,
		TemplateName:   p.template.Name,
		Title:          p.template.Name,
		Severity:       p.template.Severity,
		ReportKey:      p.reportKey,
		AttributeLabel: p.attributeLabel,
		Instances:      []string{p.bestHigh, p.bestLow},
		Summary:        fmt.Sprintf("Persistent imbalance: one node stayed high (>=%.1f%%) while another stayed low (<=%.1f%%) for %d samples.", p.highThreshold, p.lowThreshold, p.bestLen),
	}
	if !p.bestStart.IsZero() {
		out.Start = p.bestStart.UnixMilli()
	}
	if !p.bestEnd.IsZero() {
		out.End = p.bestEnd.UnixMilli()
	}
	return []DiagnosticFinding{out}
}

type numaZigzagProcessor struct {
	template     DiagnosticTemplate
	indexes      []int
	labels       []string
	minSwitches  int
	minGap       float64
	switches     int
	firstSwitch  time.Time
	lastSwitch   time.Time
	prevDominant int
	observations int
}

func (p *numaZigzagProcessor) onRow(ts time.Time, record []string) {
	bestVal := -math.MaxFloat64
	secondVal := -math.MaxFloat64
	bestIdx := -1
	valid := 0
	for i, idx := range p.indexes {
		if idx < 0 || idx >= len(record) {
			continue
		}
		v, ok := parseFloatValue(record[idx])
		if !ok || !NumberFinite(v) {
			continue
		}
		valid++
		if v > bestVal {
			secondVal = bestVal
			bestVal = v
			bestIdx = i
		} else if v > secondVal {
			secondVal = v
		}
	}
	if valid < 2 || bestIdx < 0 {
		return
	}
	if bestVal-secondVal < p.minGap {
		return
	}
	p.observations++
	if p.prevDominant >= 0 && bestIdx != p.prevDominant {
		p.switches++
		if p.firstSwitch.IsZero() {
			p.firstSwitch = ts
		}
		p.lastSwitch = ts
	}
	p.prevDominant = bestIdx
}

func (p *numaZigzagProcessor) finalize() []DiagnosticFinding {
	if p.switches < p.minSwitches || p.observations < p.minSwitches+1 {
		return nil
	}
	return []DiagnosticFinding{{
		TemplateID:   p.template.ID,
		TemplateName: p.template.Name,
		Title:        p.template.Name,
		Severity:     p.template.Severity,
		ReportKey:    "numa",
		Summary:      fmt.Sprintf("Detected %d dominance switches across NUMA nodes (%d analyzed samples).", p.switches, p.observations),
		Start:        p.firstSwitch.UnixMilli(),
		End:          p.lastSwitch.UnixMilli(),
	}}
}

type affinityProcessor struct {
	template  DiagnosticTemplate
	indexes   []int
	labels    []string
	hitCounts []int
	firstSeen []time.Time
	lastSeen  []time.Time
}

func (p *affinityProcessor) onRow(ts time.Time, record []string) {
	for i, idx := range p.indexes {
		if idx < 0 || idx >= len(record) {
			continue
		}
		if !parseTruthy(record[idx]) {
			continue
		}
		p.hitCounts[i]++
		if p.firstSeen[i].IsZero() {
			p.firstSeen[i] = ts
		}
		p.lastSeen[i] = ts
	}
}

func (p *affinityProcessor) finalize() []DiagnosticFinding {
	entities := make([]string, 0)
	var first, last time.Time
	for i, c := range p.hitCounts {
		if c == 0 {
			continue
		}
		entities = append(entities, p.labels[i])
		if first.IsZero() || (!p.firstSeen[i].IsZero() && p.firstSeen[i].Before(first)) {
			first = p.firstSeen[i]
		}
		if last.IsZero() || p.lastSeen[i].After(last) {
			last = p.lastSeen[i]
		}
	}
	if len(entities) == 0 {
		return nil
	}
	if len(entities) > 12 {
		entities = append(entities[:12], fmt.Sprintf("... and %d more", len(entities)-12))
	}
	return []DiagnosticFinding{{
		TemplateID:   p.template.ID,
		TemplateName: p.template.Name,
		Title:        p.template.Name,
		Severity:     p.template.Severity,
		ReportKey:    "cpu",
		Instances:    entities,
		Summary:      "Exclusive affinity is enabled for one or more entities. Verify pinning side-effects and contention behavior.",
		Start:        first.UnixMilli(),
		End:          last.UnixMilli(),
	}}
}

func NumberFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

func parseTruthy(s string) bool {
	s = strings.TrimSpace(strings.ToLower(s))
	return s == "true" || s == "1" || s == "yes" || s == "y"
}

func containsAnyFold(s string, subs ...string) bool {
	s = strings.ToLower(s)
	for _, sub := range subs {
		if strings.Contains(s, strings.ToLower(sub)) {
			return true
		}
	}
	return false
}

func excludedByName(name string, excludes []string) bool {
	if len(excludes) == 0 {
		return false
	}
	n := strings.ToLower(name)
	for _, ex := range excludes {
		ex = strings.TrimSpace(strings.ToLower(ex))
		if ex == "" {
			continue
		}
		if strings.Contains(n, ex) {
			return true
		}
	}
	return false
}

func excludedByRegex(name string, patterns []string) bool {
	if len(patterns) == 0 {
		return false
	}
	for _, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		re, err := regexp.Compile("(?i)" + p)
		if err != nil {
			continue
		}
		if re.MatchString(name) {
			return true
		}
	}
	return false
}

func matchesIncludedAttribute(label string, includes []string) bool {
	if len(includes) == 0 {
		return true
	}
	for _, inc := range includes {
		if strings.EqualFold(strings.TrimSpace(inc), strings.TrimSpace(label)) {
			return true
		}
	}
	return false
}

func matchesIncludedObject(object string, includes []string) bool {
	if len(includes) == 0 {
		return true
	}
	for _, inc := range includes {
		if strings.EqualFold(strings.TrimSpace(inc), strings.TrimSpace(object)) {
			return true
		}
	}
	return false
}

func evaluateTemplateCondition(c parsedColumn, cond TemplateCondition) bool {
	field := strings.TrimSpace(strings.ToLower(cond.Field))
	op := strings.TrimSpace(strings.ToLower(cond.Op))
	val := cond.Value
	var target string
	switch field {
	case "object":
		target = c.Object
	case "attribute", "attributelabel":
		target = c.AttributeLabel
	case "instance":
		target = c.Instance
	case "counter":
		target = c.Counter
	case "raw":
		target = c.Raw
	default:
		return false
	}
	targetFold := strings.ToLower(strings.TrimSpace(target))
	valueFold := strings.ToLower(strings.TrimSpace(val))

	switch op {
	case "eq", "=":
		return targetFold == valueFold
	case "neq", "!=":
		return targetFold != valueFold
	case "contains":
		return strings.Contains(targetFold, valueFold)
	case "not_contains":
		return !strings.Contains(targetFold, valueFold)
	case "regex":
		re, err := regexp.Compile("(?i)" + strings.TrimSpace(val))
		return err == nil && re.MatchString(target)
	case "not_regex":
		re, err := regexp.Compile("(?i)" + strings.TrimSpace(val))
		return err == nil && !re.MatchString(target)
	case "prefix", "starts_with":
		return strings.HasPrefix(targetFold, valueFold)
	case "suffix", "ends_with":
		return strings.HasSuffix(targetFold, valueFold)
	default:
		return false
	}
}

func matchesTemplateFilter(c parsedColumn, filter TemplateFilter) bool {
	if len(filter.Conditions) == 0 {
		return true
	}
	logic := strings.TrimSpace(strings.ToLower(filter.Logic))
	if logic == "or" {
		for _, cond := range filter.Conditions {
			if evaluateTemplateCondition(c, cond) {
				return true
			}
		}
		return false
	}
	for _, cond := range filter.Conditions {
		if !evaluateTemplateCondition(c, cond) {
			return false
		}
	}
	return true
}

func inferReportKeyFromAttribute(attr string) string {
	l := strings.ToLower(attr)
	switch {
	case strings.Contains(l, "cpu") || strings.Contains(l, "vcpu") || strings.Contains(l, "% ready") || strings.Contains(l, "% costop"):
		return "cpu"
	case strings.Contains(l, "memory") || strings.Contains(l, "swap") || strings.Contains(l, "group memory"):
		return "memory"
	case strings.Contains(l, "numa"):
		return "numa"
	case strings.Contains(l, "network") || strings.Contains(l, "net"):
		return "network"
	case strings.Contains(l, "disk") || strings.Contains(l, "storage") || strings.Contains(l, "latency"):
		return "storage"
	case strings.Contains(l, "power") || strings.Contains(l, "pstate") || strings.Contains(l, "watts"):
		return "power"
	case strings.Contains(l, "vsan"):
		return "vsan"
	default:
		return "other"
	}
}

func buildProcessors(templates []DiagnosticTemplate, cols []parsedColumn) []rowProcessor {
	var processors []rowProcessor
	for _, t := range templates {
		switch t.Detector.Type {
		case "threshold_sustained", "high_ready", "high_costop", "storage_latency", "low_numa_local", "memory_overcommit_high", "network_outbound_drop_high", "disk_adapter_failed_reads_high", "disk_adapter_driver_latency_high":
			var idxs []int
			var labels []string
			attribute := ""
			reportKey := "cpu"
			threshold := t.Detector.Threshold
			compareLess := strings.EqualFold(strings.TrimSpace(t.Detector.Comparison), "less")
			minConsecutive := t.Detector.MinConsecutive
			if minConsecutive <= 0 {
				minConsecutive = 6
			}
			if threshold <= 0 {
				switch t.Detector.Type {
				case "high_ready":
					threshold = 5
				case "high_costop":
					threshold = 3
				case "storage_latency":
					threshold = 20
				case "low_numa_local":
					threshold = 85
					compareLess = true
				case "memory_overcommit_high":
					threshold = 100
				case "network_outbound_drop_high":
					threshold = 1
				case "disk_adapter_failed_reads_high":
					threshold = 5
				case "disk_adapter_driver_latency_high":
					threshold = 30
				}
			}

			for _, c := range cols {
				l := strings.ToLower(c.AttributeLabel)
				match := false
				switch t.Detector.Type {
				case "threshold_sustained":
					match = true
					reportKey = "other"
				case "high_ready":
					match = strings.Contains(l, "% ready")
					reportKey = "cpu"
				case "high_costop":
					match = strings.Contains(l, "% costop")
					reportKey = "cpu"
				case "storage_latency":
					match = strings.Contains(l, "latency")
					reportKey = "storage"
				case "low_numa_local":
					match = strings.Contains(l, "group memory: numa % local")
					reportKey = "numa"
				case "memory_overcommit_high":
					match = strings.Contains(l, "memory: memory overcommit (1 minute avg)")
					reportKey = "memory"
				case "network_outbound_drop_high":
					match = strings.Contains(l, "network port: % outbound packets dropped")
					reportKey = "network"
				case "disk_adapter_failed_reads_high":
					match = strings.Contains(l, "failed reads/sec")
					reportKey = "storage"
				case "disk_adapter_driver_latency_high":
					match = strings.Contains(l, "average driver millisec/command")
					reportKey = "storage"
				}
				if !match {
					continue
				}
				if !matchesTemplateFilter(c, t.Detector.Filter) {
					continue
				}
				if !matchesIncludedAttribute(c.AttributeLabel, t.Detector.IncludeAttributeEquals) {
					continue
				}
				if !matchesIncludedObject(c.Object, t.Detector.IncludeObjectEquals) {
					continue
				}
				if excludedByName(c.Instance, t.Detector.ExcludeInstanceContains) {
					continue
				}
				if excludedByRegex(c.Instance, t.Detector.ExcludeInstanceRegex) {
					continue
				}
				idxs = append(idxs, c.Idx)
				labels = append(labels, c.Instance)
				if attribute == "" {
					attribute = c.AttributeLabel
				}
			}
			if len(idxs) > 0 {
				if reportKey == "other" && attribute != "" {
					reportKey = inferReportKeyFromAttribute(attribute)
				}
				processors = append(processors, &thresholdProcessor{
					template:       t,
					reportKey:      reportKey,
					attributeLabel: attribute,
					compareLess:    compareLess,
					indexes:        idxs,
					labels:         labels,
					threshold:      threshold,
					minConsecutive: minConsecutive,
					states:         make([]thresholdEntityState, len(idxs)),
				})
			}
		case "numa_zigzag", "zigzag_switch":
			var idxs []int
			var labels []string
			for _, c := range cols {
				if len(t.Detector.Filter.Conditions) > 0 {
					if !matchesTemplateFilter(c, t.Detector.Filter) {
						continue
					}
				} else if !(containsAnyFold(c.AttributeLabel, "numa") && containsAnyFold(c.AttributeLabel, "load", "% used", "% processor time")) {
					continue
				}
				idxs = append(idxs, c.Idx)
				labels = append(labels, c.AttributeLabel)
			}
			if len(idxs) >= 2 {
				minSwitches := t.Detector.MinSwitches
				if minSwitches <= 0 {
					minSwitches = 6
				}
				minGap := t.Detector.MinGap
				if minGap <= 0 {
					minGap = 3.0
				}
				processors = append(processors, &numaZigzagProcessor{
					template:     t,
					indexes:      idxs,
					labels:       labels,
					minSwitches:  minSwitches,
					minGap:       minGap,
					prevDominant: -1,
				})
			}
		case "exclusive_affinity":
			var idxs []int
			var labels []string
			for _, c := range cols {
				if containsAnyFold(c.AttributeLabel, "exclusive affinity") {
					idxs = append(idxs, c.Idx)
					labels = append(labels, c.Instance)
				}
			}
			if len(idxs) > 0 {
				processors = append(processors, &affinityProcessor{
					template:  t,
					indexes:   idxs,
					labels:    labels,
					hitCounts: make([]int, len(idxs)),
					firstSeen: make([]time.Time, len(idxs)),
					lastSeen:  make([]time.Time, len(idxs)),
				})
			}
		case "numa_imbalance", "dominance_imbalance":
			var idxs []int
			var labels []string
			for _, c := range cols {
				if len(t.Detector.Filter.Conditions) > 0 {
					if !matchesTemplateFilter(c, t.Detector.Filter) {
						continue
					}
				} else if !(strings.EqualFold(c.Object, "Numa Node") && strings.EqualFold(c.Counter, "% Processor Time")) {
					continue
				}
				idxs = append(idxs, c.Idx)
				labels = append(labels, "Numa Node "+c.Instance)
			}
			if len(idxs) >= 2 {
				high := t.Detector.HighThreshold
				if high <= 0 {
					high = 80
				}
				low := t.Detector.LowThreshold
				if low <= 0 {
					low = 20
				}
				minGap := t.Detector.MinGap
				if minGap <= 0 {
					minGap = 40
				}
				minConsecutive := t.Detector.MinConsecutive
				if minConsecutive <= 0 {
					minConsecutive = 6
				}
				processors = append(processors, &rangeImbalanceProcessor{
					template:       t,
					reportKey:      "numa",
					attributeLabel: "Numa Node: % Processor Time",
					indexes:        idxs,
					labels:         labels,
					highThreshold:  high,
					lowThreshold:   low,
					minGap:         minGap,
					minConsecutive: minConsecutive,
				})
			}
		}
	}
	return processors
}

func runDiagnostics(df *DataFile, selected []DiagnosticTemplate) (DiagnosticRunResponse, error) {
	startRun := time.Now()
	resp := DiagnosticRunResponse{Findings: []DiagnosticFinding{}}
	if df == nil {
		return resp, fmt.Errorf("no file loaded")
	}
	if len(selected) == 0 {
		return resp, nil
	}

	cols := make([]parsedColumn, 0, len(df.Columns))
	for i, c := range df.Columns {
		if i == 0 {
			continue
		}
		cols = append(cols, parsePDHColumnBackend(c, i))
	}
	processors := buildProcessors(selected, cols)
	if len(processors) == 0 {
		resp.Templates = len(selected)
		return resp, nil
	}

	f, err := os.Open(df.Path)
	if err != nil {
		return resp, err
	}
	defer f.Close()

	reader := bufio.NewReaderSize(f, 4*1024*1024)
	// consume header
	if _, err := reader.ReadBytes('\n'); err != nil && err != io.EOF {
		return resp, err
	}

	var rows int64
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return resp, err
		}
		if len(line) == 0 && errors.Is(err, io.EOF) {
			break
		}
		record, perr := readCSVLineBytes(line)
		if perr != nil || len(record) == 0 {
			if errors.Is(err, io.EOF) {
				break
			}
			continue
		}
		ts, _, terr := parseTimeValue(record[0])
		if terr != nil {
			if ms, serr := strconv.ParseInt(strings.TrimSpace(record[0]), 10, 64); serr == nil {
				ts = time.UnixMilli(ms).UTC()
			} else {
				if errors.Is(err, io.EOF) {
					break
				}
				continue
			}
		}
		rows++
		for _, p := range processors {
			p.onRow(ts, record)
		}
		if errors.Is(err, io.EOF) {
			break
		}
	}

	for _, p := range processors {
		resp.Findings = append(resp.Findings, p.finalize()...)
	}
	sort.Slice(resp.Findings, func(i, j int) bool {
		a, b := resp.Findings[i], resp.Findings[j]
		if a.Severity != b.Severity {
			order := map[string]int{"critical": 0, "high": 1, "medium": 2, "low": 3}
			return order[strings.ToLower(a.Severity)] < order[strings.ToLower(b.Severity)]
		}
		return a.Title < b.Title
	})
	resp.Templates = len(selected)
	resp.RowsScanned = rows
	resp.DurationMs = time.Since(startRun).Milliseconds()
	return resp, nil
}
