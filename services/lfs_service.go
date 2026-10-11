// Package services provides backend functionality for the IOFabrik application.
// This file contains the LFSService which wraps Git LFS CLI operations.
package services

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LFSService provides Git LFS operations via CLI
type LFSService struct {
	runner       *CommandRunner
	lfsInstalled bool
}

// NewLFSService creates a new LFSService instance
func NewLFSService() *LFSService {
	return &LFSService{
		runner: NewCommandRunner(),
	}
}

// LFSInfo contains basic information about LFS status in a repo
type LFSInfo struct {
	Enabled  bool   `json:"enabled"`
	Version  string `json:"version,omitempty"`
	HasError bool   `json:"hasError"`
	Error    string `json:"error,omitempty"`
}

// IsLFSInstalled checks if git-lfs is installed on the system.
// Positive result is cached, but a negative result is retried so runtime
// installation (portable toolchain setup) is picked up automatically.
func (l *LFSService) IsLFSInstalled() bool {
	if l.lfsInstalled {
		return true
	}

	result := l.runner.Run(".", GitPath(), "lfs", "version")
	l.lfsInstalled = result.Success
	return l.lfsInstalled
}

// GetLFSVersion returns the installed git-lfs version
func (l *LFSService) GetLFSVersion() (string, error) {
	result := l.runner.Run(".", GitPath(), "lfs", "version")
	if !result.Success {
		return "", fmt.Errorf("git-lfs is not installed: %s", result.Error)
	}
	// Output format: "git-lfs/3.4.0 (GitHub; darwin amd64; go 1.21.0)"
	output := strings.TrimSpace(result.Stdout)
	if idx := strings.Index(output, " "); idx > 0 {
		return output[:idx], nil
	}
	return output, nil
}

// IsLFSEnabled checks if Git LFS is enabled for a repository
func (l *LFSService) IsLFSEnabled(repoPath string) LFSInfo {
	info := LFSInfo{}

	if !l.IsLFSInstalled() {
		info.HasError = true
		info.Error = "Git LFS is not installed"
		return info
	}

	// Check if .gitattributes contains LFS filters
	gitattributes := filepath.Join(repoPath, ".gitattributes")
	if _, err := os.Stat(gitattributes); os.IsNotExist(err) {
		// No .gitattributes means LFS is not configured
		info.Enabled = false
		return info
	}

	// Read .gitattributes and look for lfs filter
	data, err := os.ReadFile(gitattributes)
	if err != nil {
		info.HasError = true
		info.Error = "Failed to read .gitattributes: " + err.Error()
		return info
	}

	if strings.Contains(string(data), "filter=lfs") {
		info.Enabled = true
		version, _ := l.GetLFSVersion()
		info.Version = version
	}

	return info
}

// InitializeLFS initializes Git LFS for a repository
// This runs `git lfs install` in the repo context
func (l *LFSService) InitializeLFS(repoPath string) OperationResult {
	done := LogMethod("LFSService.InitializeLFS", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return failedOp("Git LFS is not installed. Please install git-lfs first.")
	}

	result := l.runner.RunGit(repoPath, "lfs", "install")
	if !result.Success {
		return failedOp("Failed to initialize LFS: " + getErrorMessage(result))
	}

	return successOp("Git LFS initialized successfully")
}

// TrackedPattern represents a pattern tracked by Git LFS
type TrackedPattern struct {
	Pattern    string `json:"pattern"`
	Attributes string `json:"attributes,omitempty"` // e.g., "filter=lfs diff=lfs merge=lfs -text"
}

// GetTrackedPatterns returns the list of file patterns tracked by Git LFS
// Parses .gitattributes for entries with filter=lfs
func (l *LFSService) GetTrackedPatterns(repoPath string) ([]TrackedPattern, error) {
	done := LogMethod("LFSService.GetTrackedPatterns", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	patterns := []TrackedPattern{}

	gitattributes := filepath.Join(repoPath, ".gitattributes")
	file, err := os.Open(gitattributes)
	if os.IsNotExist(err) {
		return patterns, nil // No .gitattributes, no patterns
	}
	if err != nil {
		return nil, fmt.Errorf("failed to read .gitattributes: %w", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// Look for lines with filter=lfs
		if strings.Contains(line, "filter=lfs") {
			// Format: "*.ext filter=lfs diff=lfs merge=lfs -text"
			parts := strings.SplitN(line, " ", 2)
			if len(parts) >= 1 {
				pattern := TrackedPattern{
					Pattern: parts[0],
				}
				if len(parts) > 1 {
					pattern.Attributes = parts[1]
				}
				patterns = append(patterns, pattern)
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("failed to parse .gitattributes: %w", err)
	}

	return patterns, nil
}

// TrackPattern adds a file pattern to be tracked by Git LFS
// Runs: git lfs track "<pattern>"
func (l *LFSService) TrackPattern(repoPath string, pattern string) OperationResult {
	done := LogMethod("LFSService.TrackPattern", map[string]interface{}{"repoPath": repoPath, "pattern": pattern})
	defer func() { done(nil, nil) }()

	if pattern == "" {
		return failedOp("Pattern is required")
	}

	if !l.IsLFSInstalled() {
		return failedOp("Git LFS is not installed")
	}

	result := l.runner.RunGit(repoPath, "lfs", "track", pattern)
	if !result.Success {
		return failedOp("Failed to track pattern: " + getErrorMessage(result))
	}

	return successOp(fmt.Sprintf("Now tracking '%s' with Git LFS", pattern))
}

// UntrackPattern removes a file pattern from Git LFS tracking
// Runs: git lfs untrack "<pattern>"
func (l *LFSService) UntrackPattern(repoPath string, pattern string) OperationResult {
	done := LogMethod("LFSService.UntrackPattern", map[string]interface{}{"repoPath": repoPath, "pattern": pattern})
	defer func() { done(nil, nil) }()

	if pattern == "" {
		return failedOp("Pattern is required")
	}

	if !l.IsLFSInstalled() {
		return failedOp("Git LFS is not installed")
	}

	result := l.runner.RunGit(repoPath, "lfs", "untrack", pattern)
	if !result.Success {
		return failedOp("Failed to untrack pattern: " + getErrorMessage(result))
	}

	return successOp(fmt.Sprintf("Stopped tracking '%s' with Git LFS", pattern))
}

// PresetPattern represents a preset LFS tracking pattern
type PresetPattern struct {
	Pattern     string `json:"pattern"`
	Description string `json:"description"`
	Category    string `json:"category"` // e.g., "industrial", "media", "documents"
}

// presetPatterns is the static list of common LFS tracking patterns.
// Defined at package level to avoid allocation on each call.
var presetPatterns = []PresetPattern{
	// Rockwell / Allen-Bradley
	{Pattern: "*.acd", Description: "Studio 5000 Logix Designer project", Category: "industrial"},
	{Pattern: "*.mer", Description: "FactoryTalk View ME runtime", Category: "industrial"},
	{Pattern: "*.apa", Description: "FactoryTalk View SE application", Category: "industrial"},

	// Siemens
	{Pattern: "*.ap*", Description: "TIA Portal project files", Category: "industrial"},
	{Pattern: "*.zap*", Description: "TIA Portal archived project", Category: "industrial"},

	// CODESYS / IEC 61131-3
	{Pattern: "*.project", Description: "CODESYS project", Category: "industrial"},
	{Pattern: "*.projectarchive", Description: "CODESYS project archive", Category: "industrial"},

	// Beckhoff
	{Pattern: "*.tsproj", Description: "TwinCAT project", Category: "industrial"},
	{Pattern: "*.tszip", Description: "TwinCAT project archive", Category: "industrial"},

	// B&R Automation
	{Pattern: "*.asprj", Description: "Automation Studio project", Category: "industrial"},

	// General automation
	{Pattern: "*.edb", Description: "Database files", Category: "industrial"},
	{Pattern: "*.mdb", Description: "Access database files", Category: "industrial"},

	// Common binary formats
	{Pattern: "*.zip", Description: "ZIP archives", Category: "archives"},
	{Pattern: "*.7z", Description: "7-Zip archives", Category: "archives"},
	{Pattern: "*.rar", Description: "RAR archives", Category: "archives"},
	{Pattern: "*.tar.gz", Description: "Compressed tarballs", Category: "archives"},

	// CAD/CAM
	{Pattern: "*.dwg", Description: "AutoCAD drawing", Category: "cad"},
	{Pattern: "*.dxf", Description: "AutoCAD exchange format", Category: "cad"},
	{Pattern: "*.step", Description: "STEP 3D model", Category: "cad"},
	{Pattern: "*.stl", Description: "STL 3D model", Category: "cad"},

	// Images
	{Pattern: "*.psd", Description: "Photoshop document", Category: "media"},
	{Pattern: "*.ai", Description: "Adobe Illustrator file", Category: "media"},
	{Pattern: "*.png", Description: "PNG images", Category: "media"},
	{Pattern: "*.jpg", Description: "JPEG images", Category: "media"},
	{Pattern: "*.bmp", Description: "Bitmap images", Category: "media"},

	// Documents
	{Pattern: "*.pdf", Description: "PDF documents", Category: "documents"},
	{Pattern: "*.docx", Description: "Word documents", Category: "documents"},
	{Pattern: "*.xlsx", Description: "Excel spreadsheets", Category: "documents"},
	{Pattern: "*.pptx", Description: "PowerPoint presentations", Category: "documents"},
}

// GetPresetPatterns returns common file patterns for industrial automation files
func (l *LFSService) GetPresetPatterns() []PresetPattern {
	return presetPatterns
}

// LFSFileStatus represents the LFS status of a file
type LFSFileStatus struct {
	Path     string `json:"path"`
	Status   string `json:"status"`   // "lfs" for LFS-tracked, "git" for regular
	Size     string `json:"size"`     // Human-readable size
	Uploaded bool   `json:"uploaded"` // True if file is uploaded to remote
}

// LFSStatus returns the status of LFS-tracked files in the working directory
func (l *LFSService) LFSStatus(repoPath string) ([]LFSFileStatus, error) {
	done := LogMethod("LFSService.LFSStatus", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return nil, fmt.Errorf("Git LFS is not installed")
	}

	result := l.runner.RunGit(repoPath, "lfs", "status", "--porcelain")
	if !result.Success {
		return nil, fmt.Errorf("failed to get LFS status: %s", getErrorMessage(result))
	}

	files := []LFSFileStatus{}
	lines := strings.Split(result.Stdout, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// Parse LFS status output
		// Format varies by version, handle basic case
		parts := strings.Fields(line)
		if len(parts) >= 1 {
			file := LFSFileStatus{
				Path:   parts[len(parts)-1],
				Status: "lfs",
			}
			files = append(files, file)
		}
	}

	return files, nil
}

// ============================================================================
// Primitive LFS Operations - Individual Commands
// These methods wrap single git-lfs commands for maximum reusability.
// ============================================================================

// LFSFetch downloads LFS objects for the current ref or specified refs.
// Equivalent to: git lfs fetch [remote] [refs...]
func (l *LFSService) LFSFetch(repoPath string, remote string, refs ...string) OperationResult {
	runner := l.runner.forGitOperation()
	done := LogMethod("LFSService.LFSFetch", map[string]interface{}{"repoPath": repoPath, "remote": remote})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return failedOp("Git LFS is not installed")
	}

	args := []string{"lfs", "fetch"}
	if remote != "" {
		args = append(args, remote)
		args = append(args, refs...)
	}

	result := runner.RunGit(repoPath, args...)
	if !result.Success {
		return failedOp("Failed to fetch LFS objects: " + getErrorMessage(result))
	}

	return successOp("LFS objects fetched")
}

// LFSFetchAll fetches LFS objects for all refs.
// Equivalent to: git lfs fetch --all
func (l *LFSService) LFSFetchAll(repoPath string) OperationResult {
	runner := l.runner.forGitOperation()
	done := LogMethod("LFSService.LFSFetchAll", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return failedOp("Git LFS is not installed")
	}

	result := runner.RunGit(repoPath, "lfs", "fetch", "--all")
	if !result.Success {
		return failedOp("Failed to fetch LFS objects: " + getErrorMessage(result))
	}

	return successOp("All LFS objects fetched")
}

// LFSPull downloads LFS objects and checks them out into the working tree.
// Equivalent to: git lfs pull [remote]
func (l *LFSService) LFSPull(repoPath string, remote string) OperationResult {
	runner := l.runner.forGitOperation()
	done := LogMethod("LFSService.LFSPull", map[string]interface{}{"repoPath": repoPath, "remote": remote})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return failedOp("Git LFS is not installed")
	}

	args := []string{"lfs", "pull"}
	if remote != "" {
		args = append(args, remote)
	}

	result := runner.RunGit(repoPath, args...)
	if !result.Success {
		return failedOp("Failed to pull LFS objects: " + getErrorMessage(result))
	}

	return successOp("LFS objects pulled")
}

// LFSPush uploads LFS objects to the remote.
// Equivalent to: git lfs push [remote] [ref]
func (l *LFSService) LFSPush(repoPath string, remote string, ref string) OperationResult {
	runner := l.runner.forGitOperation()
	done := LogMethod("LFSService.LFSPush", map[string]interface{}{"repoPath": repoPath, "remote": remote, "ref": ref})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return failedOp("Git LFS is not installed")
	}

	args := []string{"lfs", "push", "origin", "HEAD"}
	if remote != "" {
		args = []string{"lfs", "push", remote}
		if ref != "" {
			args = append(args, ref)
		} else {
			args = append(args, "HEAD")
		}
	}

	result := runner.RunGit(repoPath, args...)
	if !result.Success {
		return failedOp("Failed to push LFS objects: " + getErrorMessage(result))
	}

	return successOp("LFS objects pushed")
}

// LFSPushAll uploads all LFS objects for all refs.
// Equivalent to: git lfs push --all [remote]
func (l *LFSService) LFSPushAll(repoPath string, remote string) OperationResult {
	runner := l.runner.forGitOperation()
	done := LogMethod("LFSService.LFSPushAll", map[string]interface{}{"repoPath": repoPath, "remote": remote})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return failedOp("Git LFS is not installed")
	}

	if remote == "" {
		remote = "origin"
	}

	result := runner.RunGit(repoPath, "lfs", "push", "--all", remote)
	if !result.Success {
		return failedOp("Failed to push LFS objects: " + getErrorMessage(result))
	}

	return successOp("All LFS objects pushed")
}

// LFSPrune removes old LFS files from the local cache.
// Equivalent to: git lfs prune
func (l *LFSService) LFSPrune(repoPath string) OperationResult {
	done := LogMethod("LFSService.LFSPrune", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return failedOp("Git LFS is not installed")
	}

	result := l.runner.forGitOperation().RunGit(repoPath, "lfs", "prune")
	if !result.Success {
		return failedOp("Failed to prune LFS cache: " + getErrorMessage(result))
	}

	return successOp("LFS cache pruned")
}

// LFSPruneDryRun shows what would be removed by prune without actually removing.
// Equivalent to: git lfs prune --dry-run
func (l *LFSService) LFSPruneDryRun(repoPath string) (string, error) {
	done := LogMethod("LFSService.LFSPruneDryRun", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return "", fmt.Errorf("Git LFS is not installed")
	}

	result := l.runner.forGitOperation().RunGit(repoPath, "lfs", "prune", "--dry-run")
	if !result.Success {
		return "", fmt.Errorf("failed to check LFS prune: %s", getErrorMessage(result))
	}

	return strings.TrimSpace(result.Stdout), nil
}

// LFSEnv returns LFS environment and configuration information.
// Equivalent to: git lfs env
func (l *LFSService) LFSEnv(repoPath string) (string, error) {
	done := LogMethod("LFSService.LFSEnv", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return "", fmt.Errorf("Git LFS is not installed")
	}

	result := l.runner.RunGit(repoPath, "lfs", "env")
	if !result.Success {
		return "", fmt.Errorf("failed to get LFS env: %s", getErrorMessage(result))
	}

	return result.Stdout, nil
}

// LFSLsFiles lists LFS-tracked files in the repository.
// Equivalent to: git lfs ls-files
func (l *LFSService) LFSLsFiles(repoPath string) ([]string, error) {
	done := LogMethod("LFSService.LFSLsFiles", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return nil, fmt.Errorf("Git LFS is not installed")
	}

	result := l.runner.RunGit(repoPath, "lfs", "ls-files", "--name-only")
	if !result.Success {
		return nil, fmt.Errorf("failed to list LFS files: %s", getErrorMessage(result))
	}

	lines := strings.Split(strings.TrimSpace(result.Stdout), "\n")
	files := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			files = append(files, line)
		}
	}

	return files, nil
}

// LFSPointer shows pointer information for a file.
// Equivalent to: git lfs pointer --file=<path>
func (l *LFSService) LFSPointer(repoPath string, filePath string) (string, error) {
	done := LogMethod("LFSService.LFSPointer", map[string]interface{}{"repoPath": repoPath, "filePath": filePath})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return "", fmt.Errorf("Git LFS is not installed")
	}

	if filePath == "" {
		return "", fmt.Errorf("file path is required")
	}

	result := l.runner.RunGit(repoPath, "lfs", "pointer", "--file="+filePath)
	if !result.Success {
		return "", fmt.Errorf("failed to get LFS pointer: %s", getErrorMessage(result))
	}

	return result.Stdout, nil
}

// LFSMigrateInfo shows migration info without making changes.
// Equivalent to: git lfs migrate info
func (l *LFSService) LFSMigrateInfo(repoPath string) (string, error) {
	done := LogMethod("LFSService.LFSMigrateInfo", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return "", fmt.Errorf("Git LFS is not installed")
	}

	result := l.runner.forGitOperation().RunGit(repoPath, "lfs", "migrate", "info")
	if !result.Success {
		return "", fmt.Errorf("failed to get migration info: %s", getErrorMessage(result))
	}

	return result.Stdout, nil
}

// LFSLock represents a locked file in Git LFS
type LFSLock struct {
	Path   string `json:"path"`
	Owner  string `json:"owner"`
	ID     string `json:"id"`
	Locked string `json:"locked"` // Timestamp
}

// isNonFatalLFSLocksError returns true for lock-list errors that should be
// treated as "no locks available" rather than hard failures.
//
// Common cases:
// - Repo has no remote configured
// - Remote URL/protocol is missing or invalid
// - LFS locking is not enabled/supported by the server
func isNonFatalLFSLocksError(errMsg string) bool {
	errLower := strings.ToLower(strings.TrimSpace(errMsg))
	if errLower == "" {
		return false
	}

	nonFatalSubstrings := []string{
		"not enabled",
		"not supported",
		"missing protocol",
		"no such remote",
		"does not appear to be a git repository",
	}

	for _, s := range nonFatalSubstrings {
		if strings.Contains(errLower, s) {
			return true
		}
	}

	return false
}

// normalizeLFSFilePath converts an incoming path to a repo-relative path suitable
// for git/lfs commands.
//
// Frontend code often deals in absolute paths, while `git lfs lock/unlock` is
// most reliable with repo-relative paths (and expects POSIX separators).
func normalizeLFSFilePath(repoPath string, filePath string) (string, error) {
	if repoPath == "" {
		return "", fmt.Errorf("repo path is required")
	}
	if filePath == "" {
		return "", fmt.Errorf("file path is required")
	}

	// If an absolute path was passed, ensure it's within the repo and convert to relative.
	if filepath.IsAbs(filePath) {
		rel, err := filepath.Rel(repoPath, filePath)
		if err != nil {
			return "", fmt.Errorf("failed to normalize file path: %w", err)
		}
		// Reject paths that escape the repo.
		if rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
			return "", fmt.Errorf("file path must be within repository")
		}
		filePath = rel
	}

	// Git expects forward slashes even on Windows.
	return filepath.ToSlash(filePath), nil
}

// LFSLocks returns the list of locked files in the repository
func (l *LFSService) LFSLocks(repoPath string) ([]LFSLock, error) {
	runner := l.runner.forGitOperation()
	done := LogMethod("LFSService.LFSLocks", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	if !l.IsLFSInstalled() {
		return nil, fmt.Errorf("Git LFS is not installed")
	}

	result := runner.RunGit(repoPath, "lfs", "locks")
	if !result.Success {
		errMsg := getErrorMessage(result)
		// LFS locking requires remote/server support. Treat known environmental
		// issues as empty locks so polling callers don't surface noisy errors.
		if isNonFatalLFSLocksError(errMsg) {
			return []LFSLock{}, nil
		}
		return nil, fmt.Errorf("failed to get LFS locks: %s", errMsg)
	}

	locks := []LFSLock{}
	lines := strings.Split(result.Stdout, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// Format: "path\towner\tID:123"
		// Or: "path\tID:123\towner"
		parts := strings.Split(line, "\t")
		if len(parts) >= 2 {
			lock := LFSLock{
				Path: parts[0],
			}
			for _, part := range parts[1:] {
				if strings.HasPrefix(part, "ID:") {
					lock.ID = strings.TrimPrefix(part, "ID:")
				} else {
					lock.Owner = part
				}
			}
			locks = append(locks, lock)
		}
	}

	return locks, nil
}

// LFSLock locks a file to prevent others from modifying it
func (l *LFSService) LFSLock(repoPath string, filePath string) OperationResult {
	runner := l.runner.forGitOperation()
	done := LogMethod("LFSService.LFSLock", map[string]interface{}{"repoPath": repoPath, "filePath": filePath})
	defer func() { done(nil, nil) }()

	if filePath == "" {
		return failedOp("File path is required")
	}

	if !l.IsLFSInstalled() {
		return failedOp("Git LFS is not installed")
	}

	normalizedPath, err := normalizeLFSFilePath(repoPath, filePath)
	if err != nil {
		return failedOp(err.Error())
	}

	result := runner.RunGit(repoPath, "lfs", "lock", normalizedPath)
	if !result.Success {
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "already locked") {
			return failedOp("File is already locked by another user")
		}
		return failedOp("Failed to lock file: " + errMsg)
	}

	return successOp(fmt.Sprintf("Locked '%s'", normalizedPath))
}

// LFSUnlock unlocks a file. If force is true, can unlock files locked by others.
func (l *LFSService) LFSUnlock(repoPath string, filePath string, force bool) OperationResult {
	runner := l.runner.forGitOperation()
	done := LogMethod("LFSService.LFSUnlock", map[string]interface{}{"repoPath": repoPath, "filePath": filePath, "force": force})
	defer func() { done(nil, nil) }()

	if filePath == "" {
		return failedOp("File path is required")
	}

	if !l.IsLFSInstalled() {
		return failedOp("Git LFS is not installed")
	}

	normalizedPath, err := normalizeLFSFilePath(repoPath, filePath)
	if err != nil {
		return failedOp(err.Error())
	}

	args := []string{"lfs", "unlock", normalizedPath}
	if force {
		args = append(args, "--force")
	}

	result := runner.RunGit(repoPath, args...)
	if !result.Success {
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "not locked") {
			return failedOp("File is not locked")
		}
		return failedOp("Failed to unlock file: " + errMsg)
	}

	return successOp(fmt.Sprintf("Unlocked '%s'", normalizedPath))
}

// GetGitUser returns the configured git user name for the repository.
// This is a standalone operation that can be used independently.
func (l *LFSService) GetGitUser(repoPath string) (string, error) {
	result := l.runner.RunGit(repoPath, "config", "user.name")
	if !result.Success {
		return "", fmt.Errorf("failed to get git user: %s", getErrorMessage(result))
	}
	return strings.TrimSpace(result.Stdout), nil
}

// FilterLocksByOwner filters a list of locks to only those owned by the specified user.
// This is a pure function that doesn't make any git calls.
func (l *LFSService) FilterLocksByOwner(locks []LFSLock, owner string) []LFSLock {
	filtered := make([]LFSLock, 0, len(locks))
	for _, lock := range locks {
		if lock.Owner == owner {
			filtered = append(filtered, lock)
		}
	}
	return filtered
}

// GetOwnLocks returns locks owned by the current git user.
// This is a composite operation that combines LFSLocks() + GetGitUser() + filtering.
func (l *LFSService) GetOwnLocks(repoPath string) ([]LFSLock, error) {
	locks, err := l.LFSLocks(repoPath)
	if err != nil {
		return nil, err
	}

	if len(locks) == 0 {
		return locks, nil
	}

	currentUser, err := l.GetGitUser(repoPath)
	if err != nil || currentUser == "" {
		// Can't determine user - return all locks as a safety measure
		return locks, nil
	}

	return l.FilterLocksByOwner(locks, currentUser), nil
}

// CheckLocksBeforeBranchSwitch checks for locked LFS files before switching branches.
// Returns a list of files that are locked by the current user.
// This is a composite operation for convenience - use GetOwnLocks() directly for more control.
func (l *LFSService) CheckLocksBeforeBranchSwitch(repoPath string) ([]LFSLock, error) {
	return l.GetOwnLocks(repoPath)
}

// ============================================================================
// Untracked Large File Detection
// ============================================================================

// UntrackedLargeFile describes a single untracked file that exceeds a size threshold.
type UntrackedLargeFile struct {
	Path     string `json:"path"`     // Relative to repo root
	Size     int64  `json:"size"`     // Size in bytes
	IsBinary bool   `json:"isBinary"` // True if content detected as non-text
}

// GetUntrackedLargeFiles returns new (not yet committed) files whose size exceeds thresholdMB.
//
// It shells out to `git status --porcelain --untracked-files=all`, filters for:
//   - ?? entries (untracked)
//   - A* entries (newly added/staged)
//
// Then it stats each file and returns those above the threshold.
// Paths in the result are relative to the repository root.
func (l *LFSService) GetUntrackedLargeFiles(repoPath string, thresholdMB int64) ([]UntrackedLargeFile, error) {
	done := LogMethod("LFSService.GetUntrackedLargeFiles", map[string]interface{}{"repoPath": repoPath, "thresholdMB": thresholdMB})
	defer func() { done(nil, nil) }()

	// Validate that repoPath is actually a git repository by checking for .git
	result := l.runner.RunGit(repoPath, "rev-parse", "--show-toplevel")
	if !result.Success {
		return nil, fmt.Errorf("not a git repository: %s", getErrorMessage(result))
	}
	repoRoot := strings.TrimSpace(result.Stdout)

	// Get untracked files via porcelain status
	result = l.runner.RunGit(repoPath, "status", "--porcelain", "--untracked-files=all")
	if !result.Success {
		return nil, fmt.Errorf("failed to get git status: %s", getErrorMessage(result))
	}

	thresholdBytes := thresholdMB * 1024 * 1024

	var largeFiles []UntrackedLargeFile

	scanner := bufio.NewScanner(strings.NewReader(result.Stdout))
	for scanner.Scan() {
		line := scanner.Text()

		if len(line) < 4 {
			continue
		}

		// Git porcelain v1 format: XY<space><path>
		// We include files that are either:
		// - untracked (??)
		// - newly added in index/worktree (A ) / (AM)
		xStatus := line[0]
		yStatus := line[1]
		if !(xStatus == '?' && yStatus == '?') && xStatus != 'A' {
			continue
		}

		// Extract path (everything after the XY and separator space),
		// then unquote Git porcelain escape/quote format.
		relPath := unquoteGitPath(line[3:])
		if relPath == "" {
			continue
		}

		absPath := filepath.Join(repoRoot, relPath)

		info, err := os.Stat(absPath)
		if err != nil {
			// File may have been deleted between status and stat — skip it
			continue
		}
		// Skip directories (git status may list them for empty untracked dirs)
		if info.IsDir() {
			continue
		}

		if info.Size() < thresholdBytes {
			continue
		}

		largeFiles = append(largeFiles, UntrackedLargeFile{
			Path:     relPath,
			Size:     info.Size(),
			IsBinary: false,
		})
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("failed to parse git status output: %w", err)
	}

	return largeFiles, nil
}
