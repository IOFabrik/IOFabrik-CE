// Package services provides backend functionality for the IOFabrik application.
// This file contains the DebugLogger — a thread-safe, in-memory ring-buffer logger
// that captures CLI command executions, service method calls, events, and errors.
// Logging is OFF by default; it can be toggled at runtime with near-zero overhead
// when disabled (atomic bool check).
package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// LogLevel represents the severity of a log entry.
type LogLevel string

const (
	LogLevelInfo  LogLevel = "info"
	LogLevelWarn  LogLevel = "warn"
	LogLevelError LogLevel = "error"
	LogLevelDebug LogLevel = "debug"
)

// LogCategory groups log entries by their origin.
type LogCategory string

const (
	LogCategoryCommand   LogCategory = "command"   // CLI command execution
	LogCategoryMethod    LogCategory = "method"    // Service method call
	LogCategoryEvent     LogCategory = "event"     // Wails event emission
	LogCategoryError     LogCategory = "error"     // Caught error
	LogCategoryLifecycle LogCategory = "lifecycle" // App start/stop, service init
)

// LogEntry is one record in the debug log ring buffer.
type LogEntry struct {
	ID        int64       `json:"id"`
	Timestamp time.Time   `json:"timestamp"`
	Level     LogLevel    `json:"level"`
	Category  LogCategory `json:"category"`
	Source    string      `json:"source"`   // e.g. "GitService.Commit"
	Message   string      `json:"message"`  // Human-readable summary
	Details   LogDetails  `json:"details"`  // Structured data
	Duration  int64       `json:"duration"` // Milliseconds, -1 if N/A
}

// LogDetails holds structured context depending on the LogCategory.
type LogDetails struct {
	// Command logs
	Command  string   `json:"command,omitempty"`
	Args     []string `json:"args,omitempty"`
	WorkDir  string   `json:"workDir,omitempty"`
	ExitCode int      `json:"exitCode,omitempty"`
	Stdout   string   `json:"stdout,omitempty"` // Truncated to maxFieldLen
	Stderr   string   `json:"stderr,omitempty"` // Truncated to maxFieldLen

	// Method logs
	Method string      `json:"method,omitempty"`
	Input  interface{} `json:"input,omitempty"`
	Output interface{} `json:"output,omitempty"`

	// Error logs
	Error string `json:"error,omitempty"`
	Stack string `json:"stack,omitempty"`
}

// LogFilter is passed to GetEntries to narrow results.
type LogFilter struct {
	Level    string `json:"level,omitempty"`    // Filter by level
	Category string `json:"category,omitempty"` // Filter by category
	Source   string `json:"source,omitempty"`   // Partial match on source
	Search   string `json:"search,omitempty"`   // Full-text search in message
	Limit    int    `json:"limit,omitempty"`    // Max entries to return (default 200)
	Offset   int    `json:"offset,omitempty"`   // Pagination offset
	Since    int64  `json:"since,omitempty"`    // Unix ms — entries after this
}

// DebugStats summarises the current state of the logger.
type DebugStats struct {
	Enabled       bool  `json:"enabled"`
	TotalEntries  int   `json:"totalEntries"`
	TotalCommands int64 `json:"totalCommands"`
	TotalMethods  int64 `json:"totalMethods"`
	TotalErrors   int64 `json:"totalErrors"`
	BufferUsage   int   `json:"bufferUsage"` // percentage 0-100
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const (
	defaultMaxEntries = 5000
	maxFieldLen       = 2048 // Truncation limit for stdout/stderr
	maxExportAgeDays  = 7
)

// Patterns for sensitive data redaction.
var sensitivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`ghp_[A-Za-z0-9_]+`),         // GitHub PAT
	regexp.MustCompile(`gho_[A-Za-z0-9_]+`),         // GitHub OAuth
	regexp.MustCompile(`glpat-[A-Za-z0-9_\-]+`),     // GitLab PAT
	regexp.MustCompile(`(https?://[^:]+:)[^@]+(@)`), // URL passwords
	regexp.MustCompile(`github_pat_[A-Za-z0-9_]+`),  // Fine-grained PAT
}

// ---------------------------------------------------------------------------
// DebugLogger — singleton ring-buffer logger
// ---------------------------------------------------------------------------

// DebugLogger is a thread-safe, in-memory ring-buffer logger.
type DebugLogger struct {
	mu      sync.RWMutex
	enabled atomic.Bool

	entries []LogEntry // ring buffer (pre-allocated)
	maxSize int
	nextID  atomic.Int64
	head    int // next write position
	count   int // how many slots are occupied (≤ maxSize)

	app *application.App // for emitting Wails events (may be nil early)

	// Counters
	totalCommands atomic.Int64
	totalErrors   atomic.Int64
	totalMethods  atomic.Int64
}

// Singleton
var (
	globalLogger     *DebugLogger
	globalLoggerOnce sync.Once
)

// GetDebugLogger returns the singleton DebugLogger instance.
func GetDebugLogger() *DebugLogger {
	globalLoggerOnce.Do(func() {
		globalLogger = &DebugLogger{
			entries: make([]LogEntry, defaultMaxEntries),
			maxSize: defaultMaxEntries,
		}
	})
	return globalLogger
}

// SetApp assigns the Wails application reference so the logger can emit events.
func (dl *DebugLogger) SetApp(app *application.App) {
	dl.mu.Lock()
	defer dl.mu.Unlock()
	dl.app = app
}

// ---------------------------------------------------------------------------
// Enable / Disable
// ---------------------------------------------------------------------------

// SetEnabled toggles debug logging at runtime.
func (dl *DebugLogger) SetEnabled(enabled bool) {
	prev := dl.enabled.Swap(enabled)
	if prev != enabled {
		action := "disabled"
		if enabled {
			action = "enabled"
		}
		// Always log this state change (even if we just got enabled).
		dl.forceLog(LogLevelInfo, LogCategoryLifecycle, "DebugLogger",
			fmt.Sprintf("Debug logging %s", action), LogDetails{}, -1)

		// Notify frontend
		dl.mu.RLock()
		app := dl.app
		dl.mu.RUnlock()
		if app != nil {
			app.Event.Emit("debug:state-changed", enabled)
		}
	}
}

// IsEnabled returns the current state (atomic — near-zero cost).
func (dl *DebugLogger) IsEnabled() bool {
	return dl.enabled.Load()
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

// Log records a LogEntry when logging is enabled. No-op when disabled.
func (dl *DebugLogger) Log(level LogLevel, category LogCategory, source, message string, details LogDetails, durationMs int64) {
	if !dl.enabled.Load() {
		return
	}
	dl.forceLog(level, category, source, message, details, durationMs)
}

// forceLog writes an entry regardless of the enabled flag (used for lifecycle events).
func (dl *DebugLogger) forceLog(level LogLevel, category LogCategory, source, message string, details LogDetails, durationMs int64) {
	entry := LogEntry{
		ID:        dl.nextID.Add(1),
		Timestamp: time.Now(),
		Level:     level,
		Category:  category,
		Source:    sanitize(source),
		Message:   sanitize(message),
		Details:   sanitizeDetails(details),
		Duration:  durationMs,
	}

	// Update counters
	switch category {
	case LogCategoryCommand:
		dl.totalCommands.Add(1)
	case LogCategoryMethod:
		dl.totalMethods.Add(1)
	}
	if level == LogLevelError {
		dl.totalErrors.Add(1)
	}

	// Write into ring buffer
	dl.mu.Lock()
	dl.entries[dl.head] = entry
	dl.head = (dl.head + 1) % dl.maxSize
	if dl.count < dl.maxSize {
		dl.count++
	}
	app := dl.app
	dl.mu.Unlock()

	// Emit event so frontend can update in real time
	if app != nil {
		app.Event.Emit("debug:new-log", entry)
	}
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// GetEntries returns log entries matching the given filter.
// Entries are returned in chronological order (oldest first).
func (dl *DebugLogger) GetEntries(filter LogFilter) []LogEntry {
	dl.mu.RLock()
	defer dl.mu.RUnlock()

	if dl.count == 0 {
		return []LogEntry{}
	}

	limit := filter.Limit
	if limit <= 0 {
		limit = 200
	}

	// Collect all entries in chronological order
	all := dl.chronologicalEntries()

	// Apply filters
	var filtered []LogEntry
	for _, e := range all {
		if !matchesFilter(e, filter) {
			continue
		}
		filtered = append(filtered, e)
	}

	// Pagination
	total := len(filtered)
	start := filter.Offset
	if start < 0 {
		start = 0
	}
	if start >= total {
		return []LogEntry{}
	}
	end := start + limit
	if end > total {
		end = total
	}

	return filtered[start:end]
}

// GetEntryByID returns a single entry by its ID, or nil if not found.
func (dl *DebugLogger) GetEntryByID(id int64) *LogEntry {
	dl.mu.RLock()
	defer dl.mu.RUnlock()

	for i := 0; i < dl.count; i++ {
		idx := (dl.head - dl.count + i + dl.maxSize) % dl.maxSize
		if dl.entries[idx].ID == id {
			entry := dl.entries[idx]
			return &entry
		}
	}
	return nil
}

// chronologicalEntries returns all entries from oldest to newest.
// Caller must hold at least an RLock.
func (dl *DebugLogger) chronologicalEntries() []LogEntry {
	result := make([]LogEntry, 0, dl.count)
	for i := 0; i < dl.count; i++ {
		idx := (dl.head - dl.count + i + dl.maxSize) % dl.maxSize
		result = append(result, dl.entries[idx])
	}
	return result
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

// Clear resets the ring buffer and counters.
func (dl *DebugLogger) Clear() {
	dl.mu.Lock()
	defer dl.mu.Unlock()

	dl.entries = make([]LogEntry, dl.maxSize)
	dl.head = 0
	dl.count = 0
	// Keep nextID incrementing to avoid ID collisions
	dl.totalCommands.Store(0)
	dl.totalErrors.Store(0)
	dl.totalMethods.Store(0)
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

// GetStats returns a snapshot of logger statistics.
func (dl *DebugLogger) GetStats() DebugStats {
	dl.mu.RLock()
	count := dl.count
	dl.mu.RUnlock()

	usage := 0
	if dl.maxSize > 0 {
		usage = (count * 100) / dl.maxSize
	}

	return DebugStats{
		Enabled:       dl.enabled.Load(),
		TotalEntries:  count,
		TotalCommands: dl.totalCommands.Load(),
		TotalMethods:  dl.totalMethods.Load(),
		TotalErrors:   dl.totalErrors.Load(),
		BufferUsage:   usage,
	}
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

// Export writes all current buffer entries to a JSON file and returns the path.
// Files are stored in the policy-managed local logs directory.
func (dl *DebugLogger) Export() (string, error) {
	dl.mu.RLock()
	entries := dl.chronologicalEntries()
	dl.mu.RUnlock()

	dir, err := configLogsDir()
	if err != nil {
		return "", fmt.Errorf("failed to determine log directory: %w", err)
	}

	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("failed to create log directory: %w", err)
	}

	filename := fmt.Sprintf("debug-%s.json", time.Now().Format("2006-01-02-150405"))
	filePath := filepath.Join(dir, filename)

	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to marshal log entries: %w", err)
	}

	if err := os.WriteFile(filePath, data, 0600); err != nil {
		return "", fmt.Errorf("failed to write log file: %w", err)
	}

	return filePath, nil
}

// CleanOldExports removes export files older than maxExportAgeDays.
func (dl *DebugLogger) CleanOldExports() {
	dir, err := configLogsDir()
	if err != nil {
		return
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}

	cutoff := time.Now().AddDate(0, 0, -maxExportAgeDays)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
}

// configLogsDir returns the policy-managed local logs directory.
func configLogsDir() (string, error) {
	dir := GetDataLocationsSnapshot().LogsDir
	if strings.TrimSpace(dir) == "" {
		return "", fmt.Errorf("empty logs directory path")
	}
	return dir, nil
}

// ---------------------------------------------------------------------------
// LogMethod helper — instrument service methods with minimal boilerplate
// ---------------------------------------------------------------------------

// LogMethod logs a service method call entry and returns a finish function
// that should be deferred to log the completion (with result and duration).
//
// Usage:
//
//	func (g *GitService) Commit(repoPath, message string) OperationResult {
//	    done := LogMethod("GitService.Commit", map[string]interface{}{"repoPath": repoPath, "message": message})
//	    // ... implementation ...
//	    defer done(result, nil)
//	    return result
//	}
func LogMethod(source string, input interface{}) func(output interface{}, err error) {
	logger := GetDebugLogger()
	if !logger.IsEnabled() {
		return func(interface{}, error) {} // no-op
	}

	start := time.Now()
	logger.Log(LogLevelDebug, LogCategoryMethod, source,
		fmt.Sprintf("→ %s called", source),
		LogDetails{Method: source, Input: input},
		-1,
	)

	return func(output interface{}, err error) {
		duration := time.Since(start).Milliseconds()
		level := LogLevelInfo
		errStr := ""
		if err != nil {
			level = LogLevelError
			errStr = err.Error()
		}
		// Also detect OperationResult failures
		if op, ok := output.(OperationResult); ok && !op.Success {
			level = LogLevelError
			if errStr == "" {
				errStr = op.Error
			}
		}
		logger.Log(level, LogCategoryMethod, source,
			fmt.Sprintf("← %s completed (%dms)", source, duration),
			LogDetails{Method: source, Output: summariseOutput(output), Error: errStr},
			duration,
		)
	}
}

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

// sanitize redacts known sensitive patterns from a string.
func sanitize(s string) string {
	for _, re := range sensitivePatterns {
		s = re.ReplaceAllString(s, "***")
	}
	return s
}

// sanitizeDetails redacts sensitive data from LogDetails fields.
func sanitizeDetails(d LogDetails) LogDetails {
	d.Command = sanitize(d.Command)
	d.Stdout = sanitize(d.Stdout)
	d.Stderr = sanitize(d.Stderr)
	d.Error = sanitize(d.Error)
	d.WorkDir = sanitize(d.WorkDir)
	for i, a := range d.Args {
		d.Args[i] = sanitize(a)
	}
	return d
}

// truncate ensures s is at most maxLen bytes, appending "…[truncated]" if cut.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "…[truncated]"
}

// summariseOutput produces a short representation suitable for log details.
// For OperationResult it returns just Success + Message/Error to avoid huge payloads.
func summariseOutput(v interface{}) interface{} {
	if v == nil {
		return nil
	}
	switch o := v.(type) {
	case OperationResult:
		return map[string]interface{}{"success": o.Success, "message": o.Message, "error": o.Error}
	case *OperationResult:
		if o == nil {
			return nil
		}
		return map[string]interface{}{"success": o.Success, "message": o.Message, "error": o.Error}
	default:
		return fmt.Sprintf("%T", v) // Just the type name for large structs
	}
}

// ---------------------------------------------------------------------------
// Filter matching
// ---------------------------------------------------------------------------

func matchesFilter(e LogEntry, f LogFilter) bool {
	if f.Level != "" && string(e.Level) != f.Level {
		return false
	}
	if f.Category != "" && string(e.Category) != f.Category {
		return false
	}
	if f.Source != "" && !strings.Contains(strings.ToLower(e.Source), strings.ToLower(f.Source)) {
		return false
	}
	if f.Search != "" && !strings.Contains(strings.ToLower(e.Message), strings.ToLower(f.Search)) {
		return false
	}
	if f.Since > 0 {
		sinceTime := time.UnixMilli(f.Since)
		if e.Timestamp.Before(sinceTime) {
			return false
		}
	}
	return true
}
