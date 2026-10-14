// Package services provides backend functionality for the IOFabrik application.
// This file contains the RepositorySettingsService which manages repository-level
// configuration and automatic background tasks like fetch, LFS sync, and maintenance.
package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Default intervals for background tasks (in minutes)
const (
	DefaultFetchInterval       = 5  // Sync branch pointers every 5 minutes
	DefaultLFSFetchInterval    = 10 // Download LFS binaries every 10 minutes
	DefaultMaintenanceInterval = 30 // Optimize local database every 30 minutes
)

// BackgroundTaskType represents a type of background task
type BackgroundTaskType string

const (
	TaskFetchAll    BackgroundTaskType = "fetch_all"
	TaskLFSFetch    BackgroundTaskType = "lfs_fetch"
	TaskMaintenance BackgroundTaskType = "maintenance"
)

// BackgroundTaskConfig represents configuration for a background task
type BackgroundTaskConfig struct {
	Enabled         bool `json:"enabled"`
	IntervalMinutes int  `json:"intervalMinutes"`
}

// LFSSettings contains LFS-specific repository settings
type LFSSettings struct {
	// AutoFetch enables automatic LFS fetch for recent work
	AutoFetch bool `json:"autoFetch"`
	// FetchRecentDays is the number of days to consider for "recent" work (git lfs fetch --recent)
	FetchRecentDays int `json:"fetchRecentDays"`
	// AutoPrune enables automatic pruning of old LFS objects
	AutoPrune bool `json:"autoPrune"`
	// PruneKeepDays is the number of days to keep LFS objects before pruning
	PruneKeepDays int `json:"pruneKeepDays"`
}

// FetchSettings contains settings for git fetch operations
type FetchSettings struct {
	// FetchAllRemotes fetches from all remotes (--all flag)
	FetchAllRemotes bool `json:"fetchAllRemotes"`
	// PruneStaleBranches removes stale remote-tracking branches (--prune flag)
	PruneStaleBranches bool `json:"pruneStaleBranches"`
	// FetchTags fetches tags (--tags flag)
	FetchTags bool `json:"fetchTags"`
}

// MaintenanceSettings contains settings for git maintenance operations
type MaintenanceSettings struct {
	// CommitGraph enables commit-graph maintenance task
	CommitGraph bool `json:"commitGraph"`
	// PackRefs enables pack-refs maintenance task
	PackRefs bool `json:"packRefs"`
	// LooseObjects enables loose-objects maintenance task
	LooseObjects bool `json:"looseObjects"`
}

// RepositorySettings contains all repository-level settings
type RepositorySettings struct {
	// RepoPath is the absolute path to the repository
	RepoPath string `json:"repoPath"`
	// RepoID is a unique identifier derived from the repo path
	RepoID string `json:"repoId"`

	// Background task configurations
	FetchTask       BackgroundTaskConfig `json:"fetchTask"`
	LFSFetchTask    BackgroundTaskConfig `json:"lfsFetchTask"`
	MaintenanceTask BackgroundTaskConfig `json:"maintenanceTask"`

	// Detailed settings
	FetchSettings       FetchSettings       `json:"fetchSettings"`
	LFSSettings         LFSSettings         `json:"lfsSettings"`
	MaintenanceSettings MaintenanceSettings `json:"maintenanceSettings"`

	// Mode flags
	LocalOnlyMode bool `json:"localOnlyMode,omitempty"`

	// Metadata
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ============================================================================
// In-Repo Config Types (.iofabrik/ directory)
// ============================================================================

// RepoLocalConfig holds shared configuration stored in .iofabrik/config.json.
// This file is committed to the repository so collaborators share these settings.
type RepoLocalConfig struct {
	CreatedAt  string `json:"createdAt,omitempty"`  // ISO 8601 timestamp of project creation
	CreatedBy  string `json:"createdBy,omitempty"`  // Username/email of the creator
	AppVersion string `json:"appVersion,omitempty"` // IOFabrik version that created the project
}

// RepoPersonalConfig holds personal/machine-specific configuration stored in
// .iofabrik/local.json. This file is added to .gitignore and NOT committed.
type RepoPersonalConfig struct {
	LocalOnlyMode bool                           `json:"localOnlyMode,omitempty"` // Skip remote sync
	DefaultBranch ProjectDefaultBranchPreference `json:"defaultBranch,omitempty"`
}

// BackgroundTaskStatus represents the current status of a background task
type BackgroundTaskStatus struct {
	TaskType   BackgroundTaskType `json:"taskType"`
	IsRunning  bool               `json:"isRunning"`
	LastRun    *time.Time         `json:"lastRun,omitempty"`
	LastResult *OperationResult   `json:"lastResult,omitempty"`
	NextRun    *time.Time         `json:"nextRun,omitempty"`
	RunCount   int                `json:"runCount"`
	ErrorCount int                `json:"errorCount"`
}

// RepositorySettingsService manages repository-level configuration and background tasks
type RepositorySettingsService struct {
	runner      *CommandRunner
	settingsDir string
	legacyDir   string
	app         *application.App

	// Background task management
	mu           sync.RWMutex
	activeRepo   string // Currently active repository path
	taskStatuses map[BackgroundTaskType]*BackgroundTaskStatus
	taskCancels  map[string]context.CancelFunc // repo path -> cancel function
	taskContexts map[string]context.Context
}

// NewRepositorySettingsService creates a new RepositorySettingsService
func NewRepositorySettingsService() *RepositorySettingsService {
	locations := GetDataLocationsSnapshot()

	return &RepositorySettingsService{
		runner:       NewCommandRunner(),
		settingsDir:  locations.RepositorySettingsDir,
		legacyDir:    locations.LegacyRepoSettingsDir,
		taskStatuses: make(map[BackgroundTaskType]*BackgroundTaskStatus),
		taskCancels:  make(map[string]context.CancelFunc),
		taskContexts: make(map[string]context.Context),
	}
}

// SetApp sets the application reference (called after app initialization)
func (r *RepositorySettingsService) SetApp(app *application.App) {
	r.app = app
}

// generateRepoID creates a unique ID for a repository based on its path
func generateRepoID(repoPath string) string {
	hash := sha256.Sum256([]byte(repoPath))
	return hex.EncodeToString(hash[:8]) // First 8 bytes = 16 hex chars
}

// getSettingsPath returns the path to the settings file for a repository
func (r *RepositorySettingsService) getSettingsPath(repoPath string) string {
	repoID := generateRepoID(repoPath)
	return filepath.Join(r.settingsDir, repoID+".json")
}

// GetDefaultSettings returns the default settings for a new repository
func (r *RepositorySettingsService) GetDefaultSettings(repoPath string) RepositorySettings {
	now := time.Now()
	return RepositorySettings{
		RepoPath:  repoPath,
		RepoID:    generateRepoID(repoPath),
		CreatedAt: now,
		UpdatedAt: now,

		// Background tasks - enabled by default with sensible intervals
		FetchTask: BackgroundTaskConfig{
			Enabled:         true,
			IntervalMinutes: DefaultFetchInterval,
		},
		LFSFetchTask: BackgroundTaskConfig{
			Enabled:         true,
			IntervalMinutes: DefaultLFSFetchInterval,
		},
		MaintenanceTask: BackgroundTaskConfig{
			Enabled:         true,
			IntervalMinutes: DefaultMaintenanceInterval,
		},

		// Fetch settings
		FetchSettings: FetchSettings{
			FetchAllRemotes:    true,
			PruneStaleBranches: true,
			FetchTags:          true,
		},

		// LFS settings
		LFSSettings: LFSSettings{
			AutoFetch:       true,
			FetchRecentDays: 7,
			AutoPrune:       false,
			PruneKeepDays:   30,
		},

		// Maintenance settings
		MaintenanceSettings: MaintenanceSettings{
			CommitGraph:  true,
			PackRefs:     false, // Can be slow, disabled by default
			LooseObjects: false, // Can be slow, disabled by default
		},
	}
}

// GetSettings retrieves settings for a repository
func (r *RepositorySettingsService) GetSettings(repoPath string) (RepositorySettings, error) {
	settingsPath := r.getSettingsPath(repoPath)

	data, err := os.ReadFile(settingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			legacyPath := filepath.Join(r.legacyDir, generateRepoID(repoPath)+".json")
			legacyData, legacyErr := os.ReadFile(legacyPath)
			if legacyErr == nil {
				data = legacyData
			} else {
				// Return default settings if file doesn't exist
				return r.GetDefaultSettings(repoPath), nil
			}
		} else {
			return RepositorySettings{}, fmt.Errorf("failed to read settings: %w", err)
		}
	}

	var settings RepositorySettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return RepositorySettings{}, fmt.Errorf("failed to parse settings: %w", err)
	}

	// Ensure repo path is current
	settings.RepoPath = repoPath
	return settings, nil
}

// SaveSettings saves settings for a repository
func (r *RepositorySettingsService) SaveSettings(settings RepositorySettings) OperationResult {
	// Ensure settings directory exists
	if err := os.MkdirAll(r.settingsDir, 0755); err != nil {
		return failedOp("Failed to create settings directory: " + err.Error())
	}

	settings.UpdatedAt = time.Now()
	settingsPath := r.getSettingsPath(settings.RepoPath)

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return failedOp("Failed to serialize settings: " + err.Error())
	}

	if err := os.WriteFile(settingsPath, data, 0644); err != nil {
		return failedOp("Failed to write settings: " + err.Error())
	}

	return successOp("Settings saved successfully")
}

// UpdateBackgroundTask updates the configuration for a specific background task
func (r *RepositorySettingsService) UpdateBackgroundTask(repoPath string, taskType BackgroundTaskType, config BackgroundTaskConfig) OperationResult {
	settings, err := r.GetSettings(repoPath)
	if err != nil {
		return failedOp(err.Error())
	}

	switch taskType {
	case TaskFetchAll:
		settings.FetchTask = config
	case TaskLFSFetch:
		settings.LFSFetchTask = config
	case TaskMaintenance:
		settings.MaintenanceTask = config
	default:
		return failedOp("Unknown task type: " + string(taskType))
	}

	result := r.SaveSettings(settings)
	if result.Success && r.activeRepo == repoPath {
		// Restart background tasks with new settings
		r.RestartBackgroundTasks(repoPath)
	}

	return result
}

// UpdateFetchSettings updates fetch-related settings
func (r *RepositorySettingsService) UpdateFetchSettings(repoPath string, fetchSettings FetchSettings) OperationResult {
	settings, err := r.GetSettings(repoPath)
	if err != nil {
		return failedOp(err.Error())
	}

	settings.FetchSettings = fetchSettings
	return r.SaveSettings(settings)
}

// UpdateLFSSettings updates LFS-related settings
func (r *RepositorySettingsService) UpdateLFSSettings(repoPath string, lfsSettings LFSSettings) OperationResult {
	settings, err := r.GetSettings(repoPath)
	if err != nil {
		return failedOp(err.Error())
	}

	settings.LFSSettings = lfsSettings
	return r.SaveSettings(settings)
}

// UpdateMaintenanceSettings updates maintenance-related settings
func (r *RepositorySettingsService) UpdateMaintenanceSettings(repoPath string, maintenanceSettings MaintenanceSettings) OperationResult {
	settings, err := r.GetSettings(repoPath)
	if err != nil {
		return failedOp(err.Error())
	}

	settings.MaintenanceSettings = maintenanceSettings
	return r.SaveSettings(settings)
}

// ResetToDefaults resets all settings for a repository to defaults
func (r *RepositorySettingsService) ResetToDefaults(repoPath string) OperationResult {
	defaults := r.GetDefaultSettings(repoPath)

	// Preserve created timestamp if settings exist
	existing, err := r.GetSettings(repoPath)
	if err == nil && !existing.CreatedAt.IsZero() {
		defaults.CreatedAt = existing.CreatedAt
	}

	return r.SaveSettings(defaults)
}

// DeleteSettings removes settings for a repository
func (r *RepositorySettingsService) DeleteSettings(repoPath string) OperationResult {
	settingsPath := r.getSettingsPath(repoPath)

	if err := os.Remove(settingsPath); err != nil && !os.IsNotExist(err) {
		return failedOp("Failed to delete settings: " + err.Error())
	}

	return successOp("Settings deleted successfully")
}

// ============================================================================
// Background Task Execution
// ============================================================================

// runFetchAll executes the fetch all command
func (r *RepositorySettingsService) runFetchAll(repoPath string, settings FetchSettings) OperationResult {
	runner := r.runner.forGitOperation()
	args := []string{"fetch"}

	if settings.FetchAllRemotes {
		args = append(args, "--all")
	}
	if settings.PruneStaleBranches {
		args = append(args, "--prune")
	}
	if settings.FetchTags {
		args = append(args, "--tags")
	}

	// Background timers must not race a Change Request snapshot fetch.
	unlock := lockChangeRequestRepo(repoPath)
	defer unlock()

	result := runner.RunGit(repoPath, args...)
	if !result.Success {
		return failedOp("Fetch failed: " + result.Stderr)
	}

	return successOp("Fetched successfully")
}

// runLFSFetch executes the LFS fetch command
func (r *RepositorySettingsService) runLFSFetch(repoPath string, settings LFSSettings) OperationResult {
	if !settings.AutoFetch {
		return successOp("LFS auto-fetch is disabled")
	}

	// Check if LFS is installed
	lfsCheck := r.runner.Run(".", GitPath(), "lfs", "version")
	if !lfsCheck.Success {
		return failedOp("Git LFS is not installed")
	}

	unlock := lockChangeRequestRepo(repoPath)
	defer unlock()

	// Run git lfs fetch --recent
	result := r.runner.forGitOperation().RunGit(repoPath, "lfs", "fetch", "--recent")
	if !result.Success {
		return failedOp("LFS fetch failed: " + result.Stderr)
	}

	return successOp("LFS fetched successfully")
}

// runMaintenance executes git maintenance tasks
func (r *RepositorySettingsService) runMaintenance(repoPath string, settings MaintenanceSettings) OperationResult {
	var errors []string
	var successes []string

	unlock := lockChangeRequestRepo(repoPath)
	defer unlock()

	if settings.CommitGraph {
		result := r.runner.RunGit(repoPath, "maintenance", "run", "--task=commit-graph")
		if result.Success {
			successes = append(successes, "commit-graph")
		} else {
			errors = append(errors, "commit-graph: "+result.Stderr)
		}
	}

	if settings.PackRefs {
		result := r.runner.RunGit(repoPath, "maintenance", "run", "--task=pack-refs")
		if result.Success {
			successes = append(successes, "pack-refs")
		} else {
			errors = append(errors, "pack-refs: "+result.Stderr)
		}
	}

	if settings.LooseObjects {
		result := r.runner.RunGit(repoPath, "maintenance", "run", "--task=loose-objects")
		if result.Success {
			successes = append(successes, "loose-objects")
		} else {
			errors = append(errors, "loose-objects: "+result.Stderr)
		}
	}

	if len(errors) > 0 {
		return failedOp("Some maintenance tasks failed: " + fmt.Sprintf("%v", errors))
	}

	if len(successes) == 0 {
		return successOp("No maintenance tasks configured")
	}

	return successOp("Maintenance completed: " + fmt.Sprintf("%v", successes))
}

// RunTaskNow runs a background task immediately
func (r *RepositorySettingsService) RunTaskNow(repoPath string, taskType BackgroundTaskType) OperationResult {
	settings, err := r.GetSettings(repoPath)
	if err != nil {
		return failedOp(err.Error())
	}

	r.mu.Lock()
	status, exists := r.taskStatuses[taskType]
	if !exists {
		status = &BackgroundTaskStatus{TaskType: taskType}
		r.taskStatuses[taskType] = status
	}
	status.IsRunning = true
	r.mu.Unlock()

	var result OperationResult

	switch taskType {
	case TaskFetchAll:
		result = r.runFetchAll(repoPath, settings.FetchSettings)
	case TaskLFSFetch:
		result = r.runLFSFetch(repoPath, settings.LFSSettings)
	case TaskMaintenance:
		result = r.runMaintenance(repoPath, settings.MaintenanceSettings)
	default:
		result = failedOp("Unknown task type: " + string(taskType))
	}

	r.mu.Lock()
	now := time.Now()
	status.IsRunning = false
	status.LastRun = &now
	status.LastResult = &result
	status.RunCount++
	if !result.Success {
		status.ErrorCount++
	}
	r.mu.Unlock()

	// Emit event for frontend
	if r.app != nil {
		r.app.Event.Emit("background-task-completed", map[string]interface{}{
			"taskType": string(taskType),
			"repoPath": repoPath,
			"success":  result.Success,
			"message":  result.Message,
			"error":    result.Error,
		})
	}

	return result
}

// GetTaskStatuses returns the current status of all background tasks
func (r *RepositorySettingsService) GetTaskStatuses() map[string]*BackgroundTaskStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()

	// Return a copy
	statuses := make(map[string]*BackgroundTaskStatus)
	for k, v := range r.taskStatuses {
		statusCopy := *v
		statuses[string(k)] = &statusCopy
	}
	return statuses
}

// ============================================================================
// Background Task Scheduler
// ============================================================================

// StartBackgroundTasks starts background tasks for a repository
func (r *RepositorySettingsService) StartBackgroundTasks(repoPath string) OperationResult {
	settings, err := r.GetSettings(repoPath)
	if err != nil {
		return failedOp(err.Error())
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	// Cancel existing tasks for this repo if any
	if cancel, exists := r.taskCancels[repoPath]; exists {
		cancel()
	}

	// Create new context for this repo's tasks
	ctx, cancel := context.WithCancel(context.Background())
	r.taskCancels[repoPath] = cancel
	r.taskContexts[repoPath] = ctx
	r.activeRepo = repoPath

	// Initialize task statuses
	r.taskStatuses[TaskFetchAll] = &BackgroundTaskStatus{TaskType: TaskFetchAll}
	r.taskStatuses[TaskLFSFetch] = &BackgroundTaskStatus{TaskType: TaskLFSFetch}
	r.taskStatuses[TaskMaintenance] = &BackgroundTaskStatus{TaskType: TaskMaintenance}

	// Start fetch task
	if settings.FetchTask.Enabled && settings.FetchTask.IntervalMinutes > 0 {
		go r.runPeriodicTask(ctx, repoPath, TaskFetchAll, time.Duration(settings.FetchTask.IntervalMinutes)*time.Minute)
	}

	// Start LFS fetch task
	if settings.LFSFetchTask.Enabled && settings.LFSFetchTask.IntervalMinutes > 0 {
		go r.runPeriodicTask(ctx, repoPath, TaskLFSFetch, time.Duration(settings.LFSFetchTask.IntervalMinutes)*time.Minute)
	}

	// Start maintenance task
	if settings.MaintenanceTask.Enabled && settings.MaintenanceTask.IntervalMinutes > 0 {
		go r.runPeriodicTask(ctx, repoPath, TaskMaintenance, time.Duration(settings.MaintenanceTask.IntervalMinutes)*time.Minute)
	}

	return successOp("Background tasks started")
}

// StopBackgroundTasks stops all background tasks for a repository
func (r *RepositorySettingsService) StopBackgroundTasks(repoPath string) OperationResult {
	r.mu.Lock()
	defer r.mu.Unlock()

	if cancel, exists := r.taskCancels[repoPath]; exists {
		cancel()
		delete(r.taskCancels, repoPath)
		delete(r.taskContexts, repoPath)
	}

	if r.activeRepo == repoPath {
		r.activeRepo = ""
	}

	return successOp("Background tasks stopped")
}

// RestartBackgroundTasks restarts all background tasks for a repository
func (r *RepositorySettingsService) RestartBackgroundTasks(repoPath string) OperationResult {
	r.StopBackgroundTasks(repoPath)
	return r.StartBackgroundTasks(repoPath)
}

// runPeriodicTask runs a task periodically until context is cancelled
func (r *RepositorySettingsService) runPeriodicTask(ctx context.Context, repoPath string, taskType BackgroundTaskType, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Calculate next run time
	r.mu.Lock()
	if status, exists := r.taskStatuses[taskType]; exists {
		nextRun := time.Now().Add(interval)
		status.NextRun = &nextRun
	}
	r.mu.Unlock()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Check if repo is still valid
			if _, err := os.Stat(repoPath); os.IsNotExist(err) {
				return
			}

			// Run the task
			r.RunTaskNow(repoPath, taskType)

			// Update next run time
			r.mu.Lock()
			if status, exists := r.taskStatuses[taskType]; exists {
				nextRun := time.Now().Add(interval)
				status.NextRun = &nextRun
			}
			r.mu.Unlock()
		}
	}
}

// ============================================================================
// Repository-Specific Git Settings
// ============================================================================

// GitRemoteInfo contains information about a git remote
type GitRemoteInfo struct {
	Name     string `json:"name"`
	FetchURL string `json:"fetchUrl"`
	PushURL  string `json:"pushUrl"`
}

// GetRemotes returns all remotes for a repository
func (r *RepositorySettingsService) GetRemotes(repoPath string) ([]GitRemoteInfo, error) {
	result := r.runner.RunGit(repoPath, "remote", "-v")
	if !result.Success {
		return nil, fmt.Errorf("failed to get remotes: %s", result.Stderr)
	}

	remotes := make(map[string]*GitRemoteInfo)
	lines := splitLines(result.Stdout)

	for _, line := range lines {
		if line == "" {
			continue
		}
		// Format: origin	https://github.com/user/repo.git (fetch)
		parts := splitByWhitespace(line)
		if len(parts) < 3 {
			continue
		}

		name := parts[0]
		url := parts[1]
		direction := parts[2]

		if _, exists := remotes[name]; !exists {
			remotes[name] = &GitRemoteInfo{Name: name}
		}

		if direction == "(fetch)" {
			remotes[name].FetchURL = url
		} else if direction == "(push)" {
			remotes[name].PushURL = url
		}
	}

	var result_list []GitRemoteInfo
	for _, remote := range remotes {
		result_list = append(result_list, *remote)
	}

	return result_list, nil
}

// GetGitConfig returns a git config value for the repository
func (r *RepositorySettingsService) GetGitConfig(repoPath string, key string) (string, error) {
	result := r.runner.RunGit(repoPath, "config", "--local", "--get", key)
	if !result.Success {
		if result.ExitCode == 1 {
			// Key not found is not an error
			return "", nil
		}
		return "", fmt.Errorf("failed to get config: %s", result.Stderr)
	}
	return trimOutput(result.Stdout), nil
}

// SetGitConfig sets a git config value for the repository
func (r *RepositorySettingsService) SetGitConfig(repoPath string, key string, value string) OperationResult {
	result := r.runner.RunGit(repoPath, "config", "--local", key, value)
	if !result.Success {
		return failedOp("Failed to set config: " + result.Stderr)
	}
	return successOp("Config set successfully")
}

// UnsetGitConfig removes a git config value from the repository
func (r *RepositorySettingsService) UnsetGitConfig(repoPath string, key string) OperationResult {
	result := r.runner.RunGit(repoPath, "config", "--local", "--unset", key)
	if !result.Success && result.ExitCode != 5 { // Exit code 5 means key doesn't exist
		return failedOp("Failed to unset config: " + result.Stderr)
	}
	return successOp("Config unset successfully")
}

// GetAllGitConfigs returns all local git config values for the repository
func (r *RepositorySettingsService) GetAllGitConfigs(repoPath string) (map[string]string, error) {
	result := r.runner.RunGit(repoPath, "config", "--local", "--list")
	if !result.Success {
		if result.ExitCode == 1 {
			// No local config is not an error
			return make(map[string]string), nil
		}
		return nil, fmt.Errorf("failed to get configs: %s", result.Stderr)
	}

	configs := make(map[string]string)
	lines := splitLines(result.Stdout)

	for _, line := range lines {
		if line == "" {
			continue
		}
		// Format: key=value
		idx := indexOf(line, "=")
		if idx > 0 {
			key := line[:idx]
			value := line[idx+1:]
			configs[key] = value
		}
	}

	return configs, nil
}

// ============================================================================
// Recovery Options for Common Git Errors
// ============================================================================

// RecoveryDiagnostics contains information about the repository state
type RecoveryDiagnostics struct {
	IsValidRepo             bool     `json:"isValidRepo"`
	HasMergeConflict        bool     `json:"hasMergeConflict"`
	HasRebaseInProgress     bool     `json:"hasRebaseInProgress"`
	HasCherryPickInProgress bool     `json:"hasCherryPickInProgress"`
	HasRevertInProgress     bool     `json:"hasRevertInProgress"`
	HasBisectInProgress     bool     `json:"hasBisectInProgress"`
	HasAMInProgress         bool     `json:"hasAMInProgress"`
	IsDetachedHead          bool     `json:"isDetachedHead"`
	CurrentBranch           string   `json:"currentBranch"`
	HasStaleLocks           bool     `json:"hasStaleLocks"`
	StaleLockFiles          []string `json:"staleLockFiles"`
	HasUncommittedChanges   bool     `json:"hasUncommittedChanges"`
	UnpushedCommits         int      `json:"unpushedCommits"`
	HasCorruptedObjects     bool     `json:"hasCorruptedObjects"`
	Issues                  []string `json:"issues"`
	Suggestions             []string `json:"suggestions"`
}

// ReflogEntry represents an entry from git reflog
type ReflogEntry struct {
	Hash      string `json:"hash"`
	ShortHash string `json:"shortHash"`
	Action    string `json:"action"`
	Message   string `json:"message"`
	Timestamp string `json:"timestamp"`
}

// DiagnoseRepository runs diagnostics on the repository to identify issues
func (r *RepositorySettingsService) DiagnoseRepository(repoPath string) RecoveryDiagnostics {
	diag := RecoveryDiagnostics{
		Issues:      []string{},
		Suggestions: []string{},
	}

	// Check if it's a valid repo
	result := r.runner.RunGit(repoPath, "rev-parse", "--is-inside-work-tree")
	diag.IsValidRepo = result.Success

	if !diag.IsValidRepo {
		diag.Issues = append(diag.Issues, "Not a valid Git repository")
		diag.Suggestions = append(diag.Suggestions, "Initialize a new repository or clone an existing one")
		return diag
	}

	// Check current branch
	branchResult := r.runner.RunGit(repoPath, "branch", "--show-current")
	if branchResult.Success {
		diag.CurrentBranch = strings.TrimSpace(branchResult.Stdout)
		if diag.CurrentBranch == "" {
			diag.IsDetachedHead = true
			diag.Issues = append(diag.Issues, "HEAD is detached (not on any branch)")
			diag.Suggestions = append(diag.Suggestions, "Use 'Recover from Detached HEAD' to get back to a branch")
		}
	}

	// Ask git where its administrative files are. Names route differently: a
	// linked worktree keeps MERGE_HEAD and HEAD.lock to itself while config.lock
	// stays shared, so joining ".git" is wrong for all of them.
	stuckNames := []string{
		"MERGE_HEAD", "rebase-merge", "rebase-apply", "rebase-apply/applying",
		"CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG",
		"index.lock", "HEAD.lock", "config.lock",
	}
	resolved, resolveErr := gitAdminPaths(r.runner, repoPath, stuckNames...)
	if resolveErr != nil {
		// Same outcome as the files being absent: report no stuck state.
		resolved = make([]string, len(stuckNames))
	}
	gitPaths := make(map[string]string, len(stuckNames))
	for i, name := range stuckNames {
		gitPaths[name] = resolved[i]
	}
	statOK := func(name string) bool {
		path := gitPaths[name]
		if path == "" {
			return false
		}
		_, err := os.Stat(path)
		return err == nil
	}

	// Check for merge in progress
	if statOK("MERGE_HEAD") {
		diag.HasMergeConflict = true
		diag.Issues = append(diag.Issues, "Merge in progress with conflicts")
		diag.Suggestions = append(diag.Suggestions, "Resolve conflicts and complete merge, or abort the merge")
	}

	// Check for rebase in progress
	if statOK("rebase-merge") {
		diag.HasRebaseInProgress = true
		diag.Issues = append(diag.Issues, "Interactive rebase in progress")
		diag.Suggestions = append(diag.Suggestions, "Continue, skip, or abort the rebase")
	}
	if statOK("rebase-apply") {
		diag.HasRebaseInProgress = true
		diag.Issues = append(diag.Issues, "Rebase in progress")
		diag.Suggestions = append(diag.Suggestions, "Continue, skip, or abort the rebase")
	}

	// Check for cherry-pick in progress
	if statOK("CHERRY_PICK_HEAD") {
		diag.HasCherryPickInProgress = true
		diag.Issues = append(diag.Issues, "Cherry-pick in progress")
		diag.Suggestions = append(diag.Suggestions, "Complete or abort the cherry-pick")
	}

	// Check for revert in progress
	if statOK("REVERT_HEAD") {
		diag.HasRevertInProgress = true
		diag.Issues = append(diag.Issues, "Revert in progress")
		diag.Suggestions = append(diag.Suggestions, "Complete or abort the revert")
	}

	// Check for bisect in progress
	if statOK("BISECT_LOG") {
		diag.HasBisectInProgress = true
		diag.Issues = append(diag.Issues, "Bug search (bisect) in progress")
		diag.Suggestions = append(diag.Suggestions, "Complete or abort the bisect session")
	}

	// Check for AM (patch application) in progress
	if statOK("rebase-apply/applying") {
		diag.HasAMInProgress = true
		diag.Issues = append(diag.Issues, "Patch application (git am) in progress")
		diag.Suggestions = append(diag.Suggestions, "Complete or abort the patch application")
	}

	// Check for stale lock files
	for _, name := range []string{"index.lock", "HEAD.lock", "config.lock"} {
		if statOK(name) {
			diag.HasStaleLocks = true
			diag.StaleLockFiles = append(diag.StaleLockFiles, gitPaths[name])
		}
	}
	if diag.HasStaleLocks {
		diag.Issues = append(diag.Issues, fmt.Sprintf("Found %d stale lock file(s)", len(diag.StaleLockFiles)))
		diag.Suggestions = append(diag.Suggestions, "Remove stale lock files to unlock Git operations")
	}

	// Check for uncommitted changes
	statusResult := r.runner.RunGit(repoPath, "status", "--porcelain")
	if statusResult.Success && strings.TrimSpace(statusResult.Stdout) != "" {
		diag.HasUncommittedChanges = true
	}

	// Check for unpushed commits only when a remote exists and upstream is configured.
	// This avoids noisy errors for local-only repositories.
	remoteResult := r.runner.RunGit(repoPath, "remote")
	if remoteResult.Success && strings.TrimSpace(remoteResult.Stdout) != "" {
		upstreamResult := r.runner.RunGit(repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
		if upstreamResult.Success {
			unpushedResult := r.runner.RunGit(repoPath, "rev-list", "--count", "@{upstream}..HEAD")
			if unpushedResult.Success {
				count := strings.TrimSpace(unpushedResult.Stdout)
				if n, err := strconv.Atoi(count); err == nil && n > 0 {
					diag.UnpushedCommits = n
				}
			}
		} else if branch := trimOutput(r.runner.RunGit(repoPath, "branch", "--show-current").Stdout); branch != "" {
			// Restricted-refspec fallback: `@{upstream}` fails when no remote-tracking
			// ref is mirrored, even though the branch is published. Resolve the remote
			// tip directly from config + ls-remote and count commits ahead of it.
			remoteName := trimOutput(r.runner.RunGit(repoPath, "config", "--get", "branch."+branch+".remote").Stdout)
			mergeRef := trimOutput(r.runner.RunGit(repoPath, "config", "--get", "branch."+branch+".merge").Stdout)
			if remoteName != "" && mergeRef != "" {
				remoteSha := firstLsRemoteSha(r.runner.forGitOperation().RunGit(repoPath, "ls-remote", "--heads", remoteName, mergeRef))
				if remoteSha != "" {
					unpushedResult := r.runner.RunGit(repoPath, "rev-list", "--count", remoteSha+"..HEAD")
					if unpushedResult.Success {
						count := strings.TrimSpace(unpushedResult.Stdout)
						if n, err := strconv.Atoi(count); err == nil && n > 0 {
							diag.UnpushedCommits = n
						}
					}
				}
			}
		}
	}

	// Check for corrupted objects (quick check)
	fsckResult := r.runner.RunGit(repoPath, "fsck", "--no-full", "--no-dangling")
	if !fsckResult.Success {
		diag.HasCorruptedObjects = true
		diag.Issues = append(diag.Issues, "Repository may have corrupted objects")
		diag.Suggestions = append(diag.Suggestions, "Run repository repair to fix corrupted objects")
	}

	return diag
}

// AbortMerge aborts an in-progress merge
func (r *RepositorySettingsService) AbortMerge(repoPath string) OperationResult {
	runner := r.runner.forGitOperation()
	result := runner.RunGit(repoPath, "merge", "--abort")
	if !result.Success {
		return failedOp("Failed to abort merge: " + result.Stderr)
	}
	return successOp("Merge aborted successfully")
}

// AbortCherryPick aborts an in-progress cherry-pick
func (r *RepositorySettingsService) AbortCherryPick(repoPath string) OperationResult {
	result := r.runner.RunGit(repoPath, "cherry-pick", "--abort")
	if !result.Success {
		return failedOp("Failed to abort cherry-pick: " + result.Stderr)
	}
	return successOp("Cherry-pick aborted successfully")
}

// RemoveStaleLocks removes stale lock files that may be blocking Git operations
func (r *RepositorySettingsService) RemoveStaleLocks(repoPath string) OperationResult {
	resolved, err := gitAdminPaths(r.runner, repoPath, "index.lock", "HEAD.lock", "config.lock", "refs/heads")
	if err != nil {
		return failedOp("Could not locate this project's internal files. Reopen the project and try again.")
	}

	// Only top-level branch names are matched, so a lock for a branch such as
	// "feature/valve-timing" is still missed. Pre-existing gap, tracked separately.
	lockFiles := []string{resolved[0], resolved[1], resolved[2], filepath.Join(resolved[3], "*.lock")}

	removed := 0
	var errors []string

	for _, pattern := range lockFiles {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			continue
		}
		for _, lockFile := range matches {
			if err := os.Remove(lockFile); err == nil {
				removed++
			} else if !os.IsNotExist(err) {
				errors = append(errors, lockFile)
			}
		}
	}

	if len(errors) > 0 {
		return failedOp(fmt.Sprintf("Removed %d lock files, but failed to remove: %v", removed, errors))
	}

	if removed == 0 {
		return successOp("No stale lock files found")
	}

	return successOp(fmt.Sprintf("Removed %d stale lock file(s)", removed))
}

// RecoverFromDetachedHead creates a new branch from detached HEAD or switches to an existing branch
func (r *RepositorySettingsService) RecoverFromDetachedHead(repoPath string, newBranchName string, switchToExisting string) OperationResult {
	runner := r.runner.forGitOperation()
	// If switchToExisting is provided, switch to that branch
	if switchToExisting != "" {
		result := runner.RunGit(repoPath, "checkout", switchToExisting)
		if !result.Success {
			return failedOp("Failed to switch to branch: " + result.Stderr)
		}
		return successOp("Switched to branch: " + switchToExisting)
	}

	// Otherwise create a new branch from current HEAD
	if newBranchName == "" {
		newBranchName = "recovered-work-" + time.Now().Format("20060102-150405")
	}

	result := runner.RunGit(repoPath, "checkout", "-b", newBranchName)
	if !result.Success {
		return failedOp("Failed to create branch: " + result.Stderr)
	}
	return successOp("Created new branch: " + newBranchName)
}

// GetReflog returns recent reflog entries for recovery purposes
func (r *RepositorySettingsService) GetReflog(repoPath string, limit int) ([]ReflogEntry, error) {
	if limit <= 0 {
		limit = 20
	}

	result := r.runner.RunGit(repoPath, "reflog", "--format=%H|%h|%gd|%gs|%cr", "-n", strconv.Itoa(limit))
	if !result.Success {
		return nil, fmt.Errorf("failed to get reflog: %s", result.Stderr)
	}

	var entries []ReflogEntry
	lines := splitLines(result.Stdout)

	for _, line := range lines {
		parts := strings.SplitN(line, "|", 5)
		if len(parts) >= 5 {
			entries = append(entries, ReflogEntry{
				Hash:      parts[0],
				ShortHash: parts[1],
				Action:    parts[2],
				Message:   parts[3],
				Timestamp: parts[4],
			})
		}
	}

	return entries, nil
}

// RecoverToReflogEntry recovers the repository to a specific reflog entry
func (r *RepositorySettingsService) RecoverToReflogEntry(repoPath string, hash string, createBranch bool, branchName string) OperationResult {
	if createBranch {
		// Create a new branch at that point
		if branchName == "" {
			branchName = "recovery-" + hash[:8]
		}
		result := r.runner.RunGit(repoPath, "branch", branchName, hash)
		if !result.Success {
			return failedOp("Failed to create recovery branch: " + result.Stderr)
		}
		return successOp("Created recovery branch: " + branchName)
	}

	// Reset to that point (dangerous, requires confirmation in frontend)
	result := r.runner.forGitOperation().RunGit(repoPath, "reset", "--hard", hash)
	if !result.Success {
		return failedOp("Failed to reset to reflog entry: " + result.Stderr)
	}
	return successOp("Reset to: " + hash)
}

// RepairRepository attempts to repair common repository issues
func (r *RepositorySettingsService) RepairRepository(repoPath string) OperationResult {
	var repairs []string
	var errors []string

	// 1. Run fsck to check for issues
	fsckResult := r.runner.RunGit(repoPath, "fsck", "--full")
	if !fsckResult.Success {
		errors = append(errors, "Repository check found issues")
	}

	// 2. Run garbage collection to clean up
	gcResult := r.runner.RunGit(repoPath, "gc", "--auto")
	if gcResult.Success {
		repairs = append(repairs, "Garbage collection completed")
	} else {
		errors = append(errors, "Garbage collection failed: "+gcResult.Stderr)
	}

	// 3. Prune unreachable objects
	pruneResult := r.runner.RunGit(repoPath, "prune")
	if pruneResult.Success {
		repairs = append(repairs, "Pruned unreachable objects")
	}

	// 4. Update commit graph
	graphResult := r.runner.RunGit(repoPath, "commit-graph", "write", "--reachable")
	if graphResult.Success {
		repairs = append(repairs, "Updated commit graph")
	}

	// 5. Repack objects
	repackResult := r.runner.RunGit(repoPath, "repack", "-a", "-d")
	if repackResult.Success {
		repairs = append(repairs, "Repacked objects")
	}

	if len(errors) > 0 && len(repairs) == 0 {
		return failedOp("Repair failed: " + strings.Join(errors, "; "))
	}

	message := "Repairs completed: " + strings.Join(repairs, ", ")
	if len(errors) > 0 {
		message += ". Warnings: " + strings.Join(errors, "; ")
	}

	return successOp(message)
}

// ResetHard performs a hard reset to a specific ref (use with caution)
func (r *RepositorySettingsService) ResetHard(repoPath string, ref string, confirm bool) OperationResult {
	runner := r.runner.forGitOperation()
	if !confirm {
		return failedOp("Hard reset requires confirmation - this will discard all uncommitted changes")
	}

	if ref == "" {
		ref = "HEAD"
	}

	result := runner.RunGit(repoPath, "reset", "--hard", ref)
	if !result.Success {
		return failedOp("Failed to reset: " + result.Stderr)
	}

	// Clean untracked files too
	cleanResult := runner.RunGit(repoPath, "clean", "-fd")
	if cleanResult.Success {
		return successOp("Reset to " + ref + " and cleaned untracked files")
	}

	return successOp("Reset to " + ref)
}

// StashAndReset stashes current changes before resetting
func (r *RepositorySettingsService) StashAndReset(repoPath string, ref string, stashMessage string) OperationResult {
	runner := r.runner.forGitOperation()
	// First stash any changes
	if stashMessage == "" {
		stashMessage = "Auto-stash before reset to " + ref
	}

	stashResult := runner.RunGit(repoPath, "stash", "push", "-m", stashMessage)
	stashedChanges := stashResult.Success && !strings.Contains(stashResult.Stdout, "No local changes")

	// Now reset
	if ref == "" {
		ref = "HEAD"
	}

	resetResult := runner.RunGit(repoPath, "reset", "--hard", ref)
	if !resetResult.Success {
		if stashedChanges {
			// Try to restore stash
			runner.RunGit(repoPath, "stash", "pop")
		}
		return failedOp("Failed to reset: " + resetResult.Stderr)
	}

	if stashedChanges {
		return successOp("Changes stashed and reset to " + ref + ". Use 'git stash pop' to restore changes.")
	}

	return successOp("Reset to " + ref)
}

// ClearCredentialCache clears cached credentials
func (r *RepositorySettingsService) ClearCredentialCache(repoPath string) OperationResult {
	// Try to clear the credential cache
	result := r.runner.RunGit(repoPath, "credential-cache", "exit")

	// This command may fail if credential-cache is not being used, which is fine
	if result.Success {
		return successOp("Credential cache cleared")
	}

	// Also try to reject stored credentials for the remote
	remoteResult := r.runner.RunGit(repoPath, "remote", "get-url", "origin")
	if remoteResult.Success {
		url := strings.TrimSpace(remoteResult.Stdout)
		rejectResult := r.runner.RunGit(repoPath, "credential", "reject")
		// Send the URL to stdin for rejection
		if rejectResult.Success {
			return successOp("Credentials cleared for " + url)
		}
	}

	return successOp("Credential cache cleared (if applicable)")
}

// FixRemoteURL updates the remote URL (useful when remote has moved or credentials changed)
func (r *RepositorySettingsService) FixRemoteURL(repoPath string, remoteName string, newURL string) OperationResult {
	if remoteName == "" {
		remoteName = "origin"
	}

	result := r.runner.RunGit(repoPath, "remote", "set-url", remoteName, newURL)
	if !result.Success {
		return failedOp("Failed to update remote URL: " + result.Stderr)
	}

	return successOp("Updated " + remoteName + " URL to: " + newURL)
}

// RecreateRemote removes and re-adds a remote
func (r *RepositorySettingsService) RecreateRemote(repoPath string, remoteName string, url string) OperationResult {
	runner := r.runner.forGitOperation()
	if remoteName == "" {
		remoteName = "origin"
	}

	// Remove existing remote (ignore errors if it doesn't exist)
	runner.RunGit(repoPath, "remote", "remove", remoteName)

	// Add new remote
	result := runner.RunGit(repoPath, "remote", "add", remoteName, url)
	if !result.Success {
		return failedOp("Failed to add remote: " + result.Stderr)
	}

	// Fetch from the new remote
	fetchResult := runner.RunGit(repoPath, "fetch", remoteName)
	if !fetchResult.Success {
		return successOp("Remote added but fetch failed: " + fetchResult.Stderr)
	}

	return successOp("Remote " + remoteName + " recreated and fetched successfully")
}

// SetUpstreamBranch sets the upstream tracking branch
func (r *RepositorySettingsService) SetUpstreamBranch(repoPath string, remoteBranch string) OperationResult {
	if remoteBranch == "" {
		// Auto-detect from current branch
		branchResult := r.runner.RunGit(repoPath, "branch", "--show-current")
		if !branchResult.Success {
			return failedOp("Failed to detect current branch")
		}
		currentBranch := strings.TrimSpace(branchResult.Stdout)
		remoteBranch = "origin/" + currentBranch
	}

	result := r.runner.RunGit(repoPath, "branch", "--set-upstream-to="+remoteBranch)
	if !result.Success {
		return failedOp("Failed to set upstream: " + result.Stderr)
	}

	return successOp("Upstream set to: " + remoteBranch)
}

// ============================================================================
// In-Repo Config: .iofabrik/ Directory
// ============================================================================

// GitignoreTemplateOption describes a selectable .gitignore template preset.
type GitignoreTemplateOption struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
}

type gitignoreTemplate struct {
	option GitignoreTemplateOption
	lines  []string
}

var gitignoreTemplates = []gitignoreTemplate{
	{
		option: GitignoreTemplateOption{
			ID:          "automation-siemens-tia",
			Name:        "Siemens TIA Portal",
			Description: "Ignore generated archives, local cache, and temporary engineering files.",
			Category:    "Automation",
		},
		lines: []string{
			"*.ap17_", "*.ap16_", "*.bak", "*.tmp", "*.log", "*.wlk", "*.~*",
			"*.db-shm", "*.db-wal", "_AutoSave/", "_Temp/", ".vs/",
		},
	},
	{
		option: GitignoreTemplateOption{
			ID:          "automation-rockwell-studio5000",
			Name:        "Rockwell Studio 5000",
			Description: "Ignore Studio 5000 backups and transient local build/export files.",
			Category:    "Automation",
		},
		lines: []string{
			"*.BAK", "*.ACD.bak", "*.L5X.bak", "*.tmp", "*.log", "*.err", "*.rpt",
			"*.sem", "*.wrk", "*.BAK[0-9][0-9][0-9].ACD",
			"_Archive/", "_Backup/", "_Temp/", "RSLogix5000 Cache/",
		},
	},
	{
		option: GitignoreTemplateOption{
			ID:          "automation-schneider-ecostruxure",
			Name:        "Schneider EcoStruxure / Unity Pro",
			Description: "Ignore machine-local workspace, diagnostics, and exported temp artifacts.",
			Category:    "Automation",
		},
		lines: []string{
			"*.bak", "*.tmp", "*.log", "*.err", "*.dmp", "*.cache",
			"_Workspace/", "_Temp/", "_Backup/", "*.suo", "*.user",
		},
	},
	{
		option: GitignoreTemplateOption{
			ID:          "automation-omron-sysmac",
			Name:        "Omron Sysmac Studio",
			Description: "Ignore local simulation cache, lock files, and temporary output.",
			Category:    "Automation",
		},
		lines: []string{
			"*.bak", "*.tmp", "*.log", "*.cache", "*.~*", "*.lock",
			"_SimCache/", "_Temp/", "_Backup/", ".idea/", ".vs/",
		},
	},
	{
		option: GitignoreTemplateOption{
			ID:          "design-cad-general",
			Name:        "CAD (General)",
			Description: "Ignore common CAD lock, autosave, and local cache files.",
			Category:    "Design",
		},
		lines: []string{
			"*.bak", "*.tmp", "*.lock", "*.lck", "*.dwl", "*.dwl2", "*.sv$", "*.ac$",
			"*.log", "*.err", "*.cache", "_AutoSave/", "_Temp/", "_Backup/",
		},
	},
	{
		option: GitignoreTemplateOption{
			ID:          "design-3d-general",
			Name:        "3D Modeling (General)",
			Description: "Ignore rendered output, autosave snapshots, and local simulation cache.",
			Category:    "Design",
		},
		lines: []string{
			"*.bak", "*.tmp", "*.cache", "*.log", "*.autosave", "*.blend1", "*.blend2",
			"*.fbm/", "_renders/", "_cache/", "_sim/", "_autosave/", "_temp/",
		},
	},
	{
		option: GitignoreTemplateOption{
			ID:          "design-solidworks",
			Name:        "SolidWorks",
			Description: "Ignore SolidWorks backup, auto-recover, and local toolbox/cache files.",
			Category:    "Design",
		},
		lines: []string{
			"*.sldasm~", "*.sldprt~", "*.slddrw~", "*.swp", "*.swar", "*.bak",
			"swxJRNL.swj", "SolidWorks Journal Files/", "SolidWorks Rx/", "_AutoRecover/",
		},
	},
}

const iofabrikDir = ".iofabrik"
const legacyProjectConfigDir = ".controlzebra"
const sharedConfigFile = "config.json"
const personalConfigFile = "local.json"

// GetGitignoreTemplates returns built-in .gitignore templates tailored for
// industrial automation and design workflows.
func (r *RepositorySettingsService) GetGitignoreTemplates() []GitignoreTemplateOption {
	options := make([]GitignoreTemplateOption, 0, len(gitignoreTemplates))
	for _, template := range gitignoreTemplates {
		options = append(options, template.option)
	}
	return options
}

// ApplyGitignoreTemplate appends missing lines from a preset template into the
// repository's .gitignore file.
func (r *RepositorySettingsService) ApplyGitignoreTemplate(repoPath string, templateID string) OperationResult {
	if strings.TrimSpace(repoPath) == "" {
		return failedOp("Repository path is required")
	}
	if strings.TrimSpace(templateID) == "" {
		return failedOp("Template ID is required")
	}

	var selected *gitignoreTemplate
	for i := range gitignoreTemplates {
		if gitignoreTemplates[i].option.ID == templateID {
			selected = &gitignoreTemplates[i]
			break
		}
	}
	if selected == nil {
		return failedOp("Unknown .gitignore template: " + templateID)
	}

	info, err := os.Stat(repoPath)
	if err != nil {
		return failedOp("Repository path does not exist")
	}
	if !info.IsDir() {
		return failedOp("Repository path must be a directory")
	}

	gitignorePath := filepath.Join(repoPath, ".gitignore")
	existingContent, _ := os.ReadFile(gitignorePath)

	existingLines := make(map[string]struct{})
	for _, line := range strings.Split(string(existingContent), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		existingLines[trimmed] = struct{}{}
	}

	missing := make([]string, 0, len(selected.lines))
	for _, line := range selected.lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if _, exists := existingLines[trimmed]; exists {
			continue
		}
		missing = append(missing, trimmed)
	}

	if len(missing) == 0 {
		return successOp(".gitignore template already applied")
	}

	file, err := os.OpenFile(gitignorePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return failedOp("Failed to open .gitignore: " + err.Error())
	}
	defer file.Close()

	var b strings.Builder
	if len(existingContent) > 0 && existingContent[len(existingContent)-1] != '\n' {
		b.WriteString("\n")
	}
	b.WriteString("\n# IOFabrik template: ")
	b.WriteString(selected.option.Name)
	b.WriteString("\n")
	for _, line := range missing {
		b.WriteString(line)
		b.WriteString("\n")
	}

	if _, err := file.WriteString(b.String()); err != nil {
		return failedOp("Failed to update .gitignore: " + err.Error())
	}

	return successOp(fmt.Sprintf("Applied %s template to .gitignore", selected.option.Name))
}

// iofabrikDirPath returns the path to the .iofabrik/ directory for a repo.
func iofabrikDirPath(repoPath string) string {
	return filepath.Join(repoPath, iofabrikDir)
}

var iofabrikDirectoryMu sync.Mutex

// prepareIOFabrikDirectory hides only directories this operation creates.
// Existing directories, including those checked out by Git, keep their attributes.
func prepareIOFabrikDirectory(dirPath string) error {
	return createIOFabrikDirectory(dirPath, hideIOFabrikDirectory)
}

func createIOFabrikDirectory(dirPath string, hide func(string) error) error {
	// Do not let another settings operation use a new directory before hiding
	// succeeds, or before a failed creation has been cleaned up for a retry.
	iofabrikDirectoryMu.Lock()
	defer iofabrikDirectoryMu.Unlock()

	if err := os.MkdirAll(filepath.Dir(dirPath), 0755); err != nil {
		return err
	}
	if err := os.Mkdir(dirPath, 0755); err != nil {
		if os.IsExist(err) {
			if info, statErr := os.Stat(dirPath); statErr == nil && info.IsDir() {
				return nil
			}
		}
		return err
	}
	if err := hide(dirPath); err != nil {
		// Remove only the newly created, empty directory. Never remove contents
		// another process may have written while the attribute change was attempted.
		if cleanupErr := os.Remove(dirPath); cleanupErr != nil {
			return fmt.Errorf("could not hide project settings folder: %w; could not remove the new folder: %v", err, cleanupErr)
		}
		return fmt.Errorf("could not hide project settings folder: %w", err)
	}
	return nil
}

func iofabrikDirectoryFailure(err error) OperationResult {
	GetDebugLogger().Log(LogLevelError, LogCategoryError, "RepositorySettingsService",
		"Could not prepare the project settings folder", LogDetails{Error: err.Error()}, -1)
	return failedOp("Could not prepare the project settings folder. Check the folder's permissions and try again.")
}

// ReadRepoLocalConfig reads the shared config (.iofabrik/config.json) from
// the repository. This file is committed and shared with collaborators.
// Returns a zero-value config if the file does not exist.
func (r *RepositorySettingsService) ReadRepoLocalConfig(repoPath string) RepoLocalConfig {
	configPath := filepath.Join(iofabrikDirPath(repoPath), sharedConfigFile)
	data, err := os.ReadFile(configPath)
	if os.IsNotExist(err) {
		data, err = os.ReadFile(filepath.Join(repoPath, legacyProjectConfigDir, sharedConfigFile))
	}
	if err != nil {
		return RepoLocalConfig{}
	}

	var config RepoLocalConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return RepoLocalConfig{}
	}
	return config
}

// WriteRepoLocalConfig writes the shared config (.iofabrik/config.json) to
// the repository. Creates the .iofabrik/ directory if it does not exist.
func (r *RepositorySettingsService) WriteRepoLocalConfig(repoPath string, config RepoLocalConfig) OperationResult {
	dirPath := iofabrikDirPath(repoPath)
	if err := prepareIOFabrikDirectory(dirPath); err != nil {
		return iofabrikDirectoryFailure(err)
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return failedOp("Failed to serialize config: " + err.Error())
	}

	configPath := filepath.Join(dirPath, sharedConfigFile)
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return failedOp("Failed to write config: " + err.Error())
	}

	return successOp("Config saved to .iofabrik/config.json")
}

// ReadRepoPersonalConfig reads the personal/machine-specific config
// (.iofabrik/local.json) from the repository. This file is gitignored and
// NOT committed. Returns a zero-value config if the file does not exist.
func (r *RepositorySettingsService) ReadRepoPersonalConfig(repoPath string) RepoPersonalConfig {
	config, _ := r.readRepoPersonalConfig(repoPath)
	return config
}

func (r *RepositorySettingsService) readRepoPersonalConfig(repoPath string) (RepoPersonalConfig, error) {
	configPath := filepath.Join(iofabrikDirPath(repoPath), personalConfigFile)
	data, err := os.ReadFile(configPath)
	if os.IsNotExist(err) {
		data, err = os.ReadFile(filepath.Join(repoPath, legacyProjectConfigDir, personalConfigFile))
	}
	if os.IsNotExist(err) {
		return RepoPersonalConfig{}, nil
	}
	if err != nil {
		return RepoPersonalConfig{}, err
	}

	var config RepoPersonalConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return RepoPersonalConfig{}, err
	}
	return config, nil
}

// WriteRepoPersonalConfig writes the personal/machine-specific config
// (.iofabrik/local.json) to the repository. Creates the .iofabrik/
// directory if it does not exist. Also ensures .iofabrik/local.json is
// listed in the repository's .gitignore so it is never committed.
func (r *RepositorySettingsService) WriteRepoPersonalConfig(repoPath string, config RepoPersonalConfig) OperationResult {
	projectDefaultBranchMu.Lock()
	defer projectDefaultBranchMu.Unlock()
	return r.writeRepoPersonalConfig(repoPath, config)
}

func (r *RepositorySettingsService) writeRepoPersonalConfig(repoPath string, config RepoPersonalConfig) OperationResult {
	dirPath := iofabrikDirPath(repoPath)
	if err := prepareIOFabrikDirectory(dirPath); err != nil {
		return iofabrikDirectoryFailure(err)
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return failedOp("Personal settings could not be saved. Try again.")
	}

	configPath := filepath.Join(dirPath, personalConfigFile)
	if err := r.ensureGitignoreEntry(repoPath, ".iofabrik/local.json"); err != nil {
		return failedOp("Personal settings could not be saved. Check the project folder permissions and try again.")
	}
	if err := writePersonalConfigAtomic(dirPath, configPath, data); err != nil {
		return failedOp("Personal settings could not be saved. Check the project folder permissions and try again.")
	}

	return successOp("Personal config saved to .iofabrik/local.json")
}

// EnsureIOFabrikDir creates the .iofabrik/ directory and ensures the
// personal config file is gitignored. Call this during project initialisation.
func (r *RepositorySettingsService) EnsureIOFabrikDir(repoPath string) OperationResult {
	dirPath := iofabrikDirPath(repoPath)
	if err := prepareIOFabrikDirectory(dirPath); err != nil {
		return iofabrikDirectoryFailure(err)
	}

	r.ensureGitignoreEntry(repoPath, ".iofabrik/local.json")

	return successOp(".iofabrik directory ready")
}

// ensureGitignoreEntry appends `entry` to the repo's .gitignore if it is not
// already present. Creates the .gitignore file if it does not exist.
func (r *RepositorySettingsService) ensureGitignoreEntry(repoPath string, entry string) error {
	gitignorePath := filepath.Join(repoPath, ".gitignore")

	existing, err := os.ReadFile(gitignorePath)
	if err == nil {
		// Check if entry already exists
		for _, line := range strings.Split(string(existing), "\n") {
			if strings.TrimSpace(line) == entry {
				return nil // Already present
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	// Append entry with a preceding newline to be safe
	f, err := os.OpenFile(gitignorePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	// If file had content and didn't end with newline, add one first
	if len(existing) > 0 && existing[len(existing)-1] != '\n' {
		if _, err := f.WriteString("\n"); err != nil {
			return err
		}
	}

	_, err = f.WriteString(entry + "\n")
	return err
}

// ============================================================================
// Helper Functions
// ============================================================================

// splitLines splits a string by newlines and returns non-empty lines
func splitLines(s string) []string {
	var lines []string
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

// splitByWhitespace splits a string by whitespace
func splitByWhitespace(s string) []string {
	return strings.Fields(s)
}

// indexOf returns the index of substr in s, or -1 if not found
func indexOf(s, substr string) int {
	return strings.Index(s, substr)
}

// Note: trimOutput is already defined in git_service.go and is package-level accessible
