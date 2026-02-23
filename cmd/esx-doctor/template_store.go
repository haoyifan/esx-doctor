package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type diagnosticTemplateStore struct {
	mu       sync.RWMutex
	path     string
	builtins map[string]DiagnosticTemplate
	custom   map[string]DiagnosticTemplate
}

func defaultTemplateStorePath() string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ".esx-doctor-templates.json"
	}
	return filepath.Join(home, ".esx-doctor", "templates.json")
}

func newDiagnosticTemplateStore(path string, builtins []DiagnosticTemplate) (*diagnosticTemplateStore, error) {
	if strings.TrimSpace(path) == "" {
		path = defaultTemplateStorePath()
	}
	s := &diagnosticTemplateStore{
		path:     path,
		builtins: make(map[string]DiagnosticTemplate, len(builtins)),
		custom:   map[string]DiagnosticTemplate{},
	}
	for _, t := range builtins {
		s.builtins[t.ID] = t
	}
	if err := s.loadCustom(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *diagnosticTemplateStore) loadCustom() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var payload struct {
		Templates []DiagnosticTemplate `json:"templates"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return fmt.Errorf("invalid template store file: %w", err)
	}
	for _, t := range payload.Templates {
		if strings.TrimSpace(t.ID) == "" {
			continue
		}
		if _, exists := s.builtins[t.ID]; exists {
			continue
		}
		s.custom[t.ID] = normalizeTemplate(t)
	}
	return nil
}

func (s *diagnosticTemplateStore) persistCustomLocked() error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	out := make([]DiagnosticTemplate, 0, len(s.custom))
	for _, t := range s.custom {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	data, err := json.MarshalIndent(map[string]any{"templates": out}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0o644)
}

func normalizeTemplate(t DiagnosticTemplate) DiagnosticTemplate {
	t.ID = strings.TrimSpace(t.ID)
	t.Name = strings.TrimSpace(t.Name)
	t.Description = strings.TrimSpace(t.Description)
	if strings.TrimSpace(t.Severity) == "" {
		t.Severity = "medium"
	}
	if strings.TrimSpace(t.Detector.Type) == "" {
		t.Detector.Type = "threshold_sustained"
	}
	if strings.TrimSpace(t.Detector.Filter.Logic) == "" {
		t.Detector.Filter.Logic = "and"
	}
	if t.Detector.MinConsecutive <= 0 {
		t.Detector.MinConsecutive = 6
	}
	return t
}

func (s *diagnosticTemplateStore) list() []DiagnosticTemplate {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]DiagnosticTemplate, 0, len(s.builtins)+len(s.custom))
	for _, t := range s.builtins {
		out = append(out, normalizeTemplate(t))
	}
	for _, t := range s.custom {
		out = append(out, normalizeTemplate(t))
	}
	sort.Slice(out, func(i, j int) bool {
		if strings.EqualFold(out[i].Name, out[j].Name) {
			return out[i].ID < out[j].ID
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

func (s *diagnosticTemplateStore) byID(ids []string) []DiagnosticTemplate {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(ids) == 0 {
		all := make([]DiagnosticTemplate, 0, len(s.builtins)+len(s.custom))
		for _, t := range s.builtins {
			if t.Enabled {
				all = append(all, normalizeTemplate(t))
			}
		}
		for _, t := range s.custom {
			if t.Enabled {
				all = append(all, normalizeTemplate(t))
			}
		}
		return all
	}
	out := make([]DiagnosticTemplate, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if t, ok := s.custom[id]; ok {
			out = append(out, normalizeTemplate(t))
			continue
		}
		if t, ok := s.builtins[id]; ok {
			out = append(out, normalizeTemplate(t))
		}
	}
	return out
}

func templateIDFromName(name string) string {
	name = strings.TrimSpace(strings.ToLower(name))
	if name == "" {
		return fmt.Sprintf("custom.%d", time.Now().UnixNano())
	}
	var b strings.Builder
	lastDot := false
	for _, ch := range name {
		if (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') {
			b.WriteRune(ch)
			lastDot = false
			continue
		}
		if !lastDot {
			b.WriteRune('.')
			lastDot = true
		}
	}
	id := strings.Trim(b.String(), ".")
	if id == "" {
		id = fmt.Sprintf("custom.%d", time.Now().UnixNano())
	}
	return "custom." + id
}

func (s *diagnosticTemplateStore) upsert(t DiagnosticTemplate) (DiagnosticTemplate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t = normalizeTemplate(t)
	if t.ID == "" {
		t.ID = templateIDFromName(t.Name)
	}
	if strings.TrimSpace(t.Name) == "" {
		return t, fmt.Errorf("template name is required")
	}
	if strings.TrimSpace(t.Detector.Type) == "" {
		return t, fmt.Errorf("detector type is required")
	}
	if _, exists := s.builtins[t.ID]; exists {
		return t, fmt.Errorf("built-in template %q is read-only; duplicate to customize", t.ID)
	}
	s.custom[t.ID] = t
	if err := s.persistCustomLocked(); err != nil {
		return t, err
	}
	return t, nil
}

func (s *diagnosticTemplateStore) delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("template id is required")
	}
	if _, exists := s.builtins[id]; exists {
		return fmt.Errorf("built-in templates cannot be deleted")
	}
	delete(s.custom, id)
	return s.persistCustomLocked()
}

func (s *diagnosticTemplateStore) importTemplates(in []DiagnosticTemplate, replace bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if replace {
		s.custom = map[string]DiagnosticTemplate{}
	}
	for _, t := range in {
		t = normalizeTemplate(t)
		if t.ID == "" {
			t.ID = templateIDFromName(t.Name)
		}
		if _, exists := s.builtins[t.ID]; exists {
			continue
		}
		if t.Name == "" || t.Detector.Type == "" {
			continue
		}
		s.custom[t.ID] = t
	}
	return s.persistCustomLocked()
}

func (s *diagnosticTemplateStore) exportTemplates() []DiagnosticTemplate {
	return s.list()
}
