// Package services provides backend functionality for the IOFabrik application.
// This file contains the FileWatcherService which watches directories for changes
// and emits events to the frontend for event-based UI refresh.
package services

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// FileWatcherService watches directories for file changes and emits events
type FileWatcherService struct {
	app     *application.App
	bus     *RepoEventBus
	watcher *fsnotify.Watcher
	mu      sync.Mutex

	// Coalescing batch: accumulate FS events, emit after a quiet period.
	// This prevents event storms on Windows where fsnotify/ReadDirectoryChangesW
	// fires multiple events per file operation.
	batchDelay   time.Duration
	batchTimer   *time.Timer
	batchMu      sync.Mutex
	pendingBatch map[string]FileChangeEvent

	// Currently watched path
	watchedPath string
}

// FileChangeEvent represents a file change event sent to the frontend
type FileChangeEvent struct {
	Path      string `json:"path"`
	EventType string `json:"eventType"` // "create", "write", "remove", "rename"
	IsDir     bool   `json:"isDir"`
	Timestamp int64  `json:"timestamp"` // Unix milliseconds
}

// NewFileWatcherService creates a new FileWatcherService instance
func NewFileWatcherService() *FileWatcherService {
	return &FileWatcherService{
		batchDelay:   300 * time.Millisecond, // Coalesce events within 300ms quiet period
		pendingBatch: make(map[string]FileChangeEvent),
	}
}

// SetApp sets the Wails application reference for event emission
func (f *FileWatcherService) SetApp(app *application.App) {
	f.app = app
}

// SetRepoEventBus wires the watcher to the repository event bus, so changes
// made outside the app (a terminal merge, an editor saving a resolved file)
// invalidate the services that cache repository state.
func (f *FileWatcherService) SetRepoEventBus(bus *RepoEventBus) {
	f.bus = bus
}

// WatchDirectory starts watching a directory for changes
// Returns an error if the directory cannot be watched
func (f *FileWatcherService) WatchDirectory(path string) OperationResult {
	f.mu.Lock()
	defer f.mu.Unlock()

	// Stop existing watcher if any
	if f.watcher != nil {
		f.watcher.Close()
		f.watcher = nil
		f.watchedPath = ""
	}

	// Cancel any pending batch from previous watcher
	f.batchMu.Lock()
	if f.batchTimer != nil {
		f.batchTimer.Stop()
		f.batchTimer = nil
	}
	f.pendingBatch = make(map[string]FileChangeEvent)
	f.batchMu.Unlock()

	// Validate path
	info, err := os.Stat(path)
	if err != nil {
		return OperationResult{
			Success: false,
			Error:   "Directory not found: " + path,
		}
	}
	if !info.IsDir() {
		return OperationResult{
			Success: false,
			Error:   "Path is not a directory: " + path,
		}
	}

	// Create new watcher
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return OperationResult{
			Success: false,
			Error:   "Failed to create file watcher: " + err.Error(),
		}
	}

	f.watcher = watcher
	f.watchedPath = path

	// Add the root directory and immediate subdirectories (non-recursive for performance)
	err = f.addWatchPath(path)
	if err != nil {
		f.watcher.Close()
		f.watcher = nil
		f.watchedPath = ""
		return OperationResult{
			Success: false,
			Error:   "Failed to watch directory: " + err.Error(),
		}
	}

	// Start the event loop
	go f.eventLoop()

	return OperationResult{
		Success: true,
		Message: "Watching directory: " + path,
	}
}

// addWatchPath adds a path and its immediate subdirectories to the watcher
func (f *FileWatcherService) addWatchPath(path string) error {
	// Add the root path
	err := f.watcher.Add(path)
	if err != nil {
		return err
	}

	// Add immediate subdirectories (one level deep for performance)
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil // Non-fatal, continue with root only
	}

	for _, entry := range entries {
		if entry.IsDir() {
			name := entry.Name()
			// Skip hidden directories and common large directories
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor" || name == "__pycache__" {
				continue
			}
			subPath := filepath.Join(path, name)
			_ = f.watcher.Add(subPath) // Ignore errors for subdirectories
		}
	}

	return nil
}

// StopWatching stops watching the current directory
func (f *FileWatcherService) StopWatching() OperationResult {
	f.mu.Lock()
	defer f.mu.Unlock()

	// Cancel pending batch timer
	f.batchMu.Lock()
	if f.batchTimer != nil {
		f.batchTimer.Stop()
		f.batchTimer = nil
	}
	f.pendingBatch = make(map[string]FileChangeEvent)
	f.batchMu.Unlock()

	if f.watcher != nil {
		f.watcher.Close()
		f.watcher = nil
		f.watchedPath = ""
		return OperationResult{
			Success: true,
			Message: "Stopped watching",
		}
	}

	return OperationResult{
		Success: true,
		Message: "No active watcher",
	}
}

// GetWatchedPath returns the currently watched path
func (f *FileWatcherService) GetWatchedPath() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.watchedPath
}

// eventLoop processes file system events and emits them to the frontend
func (f *FileWatcherService) eventLoop() {
	for {
		select {
		case event, ok := <-f.watcher.Events:
			if !ok {
				return // Watcher closed
			}
			f.handleEvent(event)

		case err, ok := <-f.watcher.Errors:
			if !ok {
				return // Watcher closed
			}
			// Log error but continue watching
			if f.app != nil {
				f.app.Event.Emit("files-watcher-error", err.Error())
			}
		}
	}
}

// handleEvent processes a single file system event using coalescing batch.
// Events are accumulated and emitted together after a quiet period, preventing
// the event storms that cause UI flickering on Windows.
func (f *FileWatcherService) handleEvent(event fsnotify.Event) {
	// Determine event type
	var eventType string
	switch {
	case event.Op&fsnotify.Create != 0:
		eventType = "create"
	case event.Op&fsnotify.Write != 0:
		eventType = "write"
	case event.Op&fsnotify.Remove != 0:
		eventType = "remove"
	case event.Op&fsnotify.Rename != 0:
		eventType = "rename"
	case event.Op&fsnotify.Chmod != 0:
		return // Ignore chmod events
	default:
		return
	}

	// Skip temporary files and editor swap files
	name := filepath.Base(event.Name)
	if strings.HasPrefix(name, ".") && (strings.HasSuffix(name, ".swp") || strings.HasSuffix(name, ".swx")) {
		return
	}
	if strings.HasSuffix(name, "~") || strings.HasPrefix(name, "#") {
		return
	}

	// Check if path is a directory
	isDir := false
	if info, err := os.Stat(event.Name); err == nil {
		isDir = info.IsDir()
	}

	// If a new directory was created, start watching it
	if eventType == "create" && isDir {
		dirName := filepath.Base(event.Name)
		if !strings.HasPrefix(dirName, ".") && dirName != "node_modules" && dirName != "vendor" && dirName != "__pycache__" {
			_ = f.watcher.Add(event.Name)
		}
	}

	// Add to coalescing batch (dedupes by path — latest event type wins)
	f.batchMu.Lock()
	f.pendingBatch[event.Name] = FileChangeEvent{
		Path:      event.Name,
		EventType: eventType,
		IsDir:     isDir,
		Timestamp: time.Now().UnixMilli(),
	}
	// Reset the coalescing timer — waits for a quiet period before flushing
	if f.batchTimer != nil {
		f.batchTimer.Stop()
	}
	f.batchTimer = time.AfterFunc(f.batchDelay, f.flushBatch)
	f.batchMu.Unlock()
}

// flushBatch emits all accumulated file change events to the frontend.
// Called after the coalescing quiet period expires.
func (f *FileWatcherService) flushBatch() {
	f.batchMu.Lock()
	batch := f.pendingBatch
	f.pendingBatch = make(map[string]FileChangeEvent)
	f.batchMu.Unlock()

	if len(batch) == 0 {
		return
	}

	if watchedPath := f.GetWatchedPath(); watchedPath != "" {
		f.bus.Publish(RepoMutated{RepoPath: watchedPath, Reason: RepoMutationWorkingTree})
	}

	if f.app == nil {
		return
	}

	// Emit individual events for consumers that need per-file detail (e.g. RepoContext)
	for _, evt := range batch {
		f.app.Event.Emit("files-changed", evt)
	}
}
