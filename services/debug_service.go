// Package services provides backend functionality for the IOFabrik application.
// This file contains the DebugService which is exposed to the frontend via Wails
// bindings. It provides methods to enable/disable logging, retrieve log entries,
// export logs to disk, and get statistics.
package services

// DebugService is the Wails-exposed service for the debug logging system.
type DebugService struct {
	logger *DebugLogger
}

// NewDebugService creates a new DebugService backed by the singleton DebugLogger.
func NewDebugService() *DebugService {
	return &DebugService{
		logger: GetDebugLogger(),
	}
}

// IsEnabled returns whether debug logging is currently active.
func (d *DebugService) IsEnabled() bool {
	return d.logger.IsEnabled()
}

// SetEnabled toggles debug logging on or off at runtime.
func (d *DebugService) SetEnabled(enabled bool) {
	d.logger.SetEnabled(enabled)
}

// GetLogs returns log entries matching the given filter.
func (d *DebugService) GetLogs(filter LogFilter) []LogEntry {
	return d.logger.GetEntries(filter)
}

// ClearLogs removes all entries from the ring buffer.
func (d *DebugService) ClearLogs() {
	d.logger.Clear()
}

// ExportLogs writes all current entries to a JSON file on disk and returns the path.
// Returns an empty string if export fails.
func (d *DebugService) ExportLogs() string {
	path, err := d.logger.Export()
	if err != nil {
		// Log the export failure itself
		d.logger.Log(LogLevelError, LogCategoryLifecycle, "DebugService.ExportLogs",
			"Failed to export logs: "+err.Error(), LogDetails{Error: err.Error()}, -1)
		return ""
	}
	return path
}

// GetStats returns a summary of the logger state (entry counts, buffer usage, etc.).
func (d *DebugService) GetStats() DebugStats {
	return d.logger.GetStats()
}

// GetLogByID retrieves a single log entry by its unique ID.
// Returns nil if not found.
func (d *DebugService) GetLogByID(id int64) *LogEntry {
	return d.logger.GetEntryByID(id)
}
