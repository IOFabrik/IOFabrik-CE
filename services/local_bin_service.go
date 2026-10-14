package services

import (
	"fmt"
	"github.com/wailsapp/wails/v3/pkg/application"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

// LocalBinProgress is emitted to the frontend while portable tools are being prepared.
type LocalBinProgress struct {
	Component  string  `json:"component"`
	Phase      string  `json:"phase"`
	Message    string  `json:"message"`
	Downloaded int64   `json:"downloaded"`
	Total      int64   `json:"total"`
	Percent    float64 `json:"percent"`
	Success    bool    `json:"success"`
	Error      string  `json:"error,omitempty"`
}

// LocalBinStatus reports the current local portable tool availability.
type LocalBinStatus struct {
	BinRoot string `json:"binRoot"`

	GitPath string `json:"gitPath"`
	GhPath  string `json:"ghPath"`
	LfsPath string `json:"lfsPath"`

	HasGit bool `json:"hasGit"`
	HasGh  bool `json:"hasGh"`
	HasLfs bool `json:"hasLfs"`
}

// LocalBinService validates the toolchain supplied by the offline installer.
type LocalBinService struct {
	app         *application.App
	mu          sync.Mutex
	initialized bool
}

func NewLocalBinService() *LocalBinService             { return &LocalBinService{} }
func (s *LocalBinService) SetApp(app *application.App) { s.app = app }
func (s *LocalBinService) emitProgress(p LocalBinProgress) {
	if s.app != nil {
		s.app.Event.Emit("local-bin:progress", p)
	}
}

// GetStatus returns whether local managed binaries exist.
func (s *LocalBinService) GetStatus() LocalBinStatus {
	status := LocalBinStatus{
		BinRoot: LocalBinRootPath(),
	}

	for _, candidate := range localManagedGitPathCandidates() {
		if fileExists(candidate) {
			status.GitPath = candidate
			status.HasGit = true
			break
		}
	}

	for _, candidate := range localManagedGhPathCandidates() {
		if fileExists(candidate) {
			status.GhPath = candidate
			status.HasGh = true
			break
		}
	}

	for _, candidate := range localManagedLfsPathCandidates() {
		if fileExists(candidate) {
			status.LfsPath = candidate
			status.HasLfs = true
			break
		}
	}

	return status
}

// EnsurePortableToolchainIfNeeded prepares installed tools without network access.
func (s *LocalBinService) EnsurePortableToolchainIfNeeded() OperationResult {
	return s.EnsurePortableToolchain()
}

// EnsurePortableToolchain never downloads or replaces installed tools.
func (s *LocalBinService) EnsurePortableToolchain() OperationResult {
	if runtime.GOOS != "windows" {
		return successOp("Portable toolchain manager is active on Windows only")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	status := s.GetStatus()
	if err := validateInstalledToolchain(status, isBusyBoxGit()); err != nil {
		return failedOp(err.Error())
	}
	if s.initialized {
		return successOp("Portable toolchain is ready")
	}
	RefreshCLIPaths()
	result := NewCommandRunner().Run("", GitPath(), "lfs", "install", "--skip-repo")
	if !result.Success {
		log.Printf("[LocalBinService] LFS initialization failed: %s %s", result.Error, result.Stderr)
		return failedOp("File support could not be prepared. Restart IOFabrik or reinstall it using the full installer.")
	}
	s.initialized = true
	s.emitProgress(LocalBinProgress{Component: "toolchain", Phase: "done", Message: "Portable toolchain ready", Percent: 100, Success: true})
	return successOp("Portable toolchain ready")
}

func validateInstalledToolchain(status LocalBinStatus, busyBox bool) error {
	if !status.HasGit || !status.HasGh || !status.HasLfs || busyBox {
		return fmt.Errorf("Required supporting tools are missing or incomplete. Reinstall IOFabrik using the full installer.")
	}
	return nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// isBusyBoxGit returns true if the managed portable Git directory contains a
// BusyBox-based MinGit installation. The BusyBox variant ships a busybox.exe
// in the mingw64/bin (or top-level) directory instead of individual MSYS2 utilities.
func isBusyBoxGit() bool {
	gitRoot := filepath.Join(LocalBinRootPath(), "git")
	candidates := []string{
		filepath.Join(gitRoot, "mingw64", "bin", "busybox.exe"),
		filepath.Join(gitRoot, "clangarm64", "bin", "busybox.exe"),
		filepath.Join(gitRoot, "bin", "busybox.exe"),
		filepath.Join(gitRoot, "usr", "bin", "busybox.exe"),
	}
	for _, p := range candidates {
		if fileExists(p) {
			return true
		}
	}

	// Also check: if usr/bin/sh.exe is missing, this is likely BusyBox MinGit
	// (the regular variant includes usr/bin/sh.exe as a proper MSYS2 shell).
	shPath := filepath.Join(gitRoot, "usr", "bin", "sh.exe")
	if !fileExists(shPath) {
		// Only flag as BusyBox if the git directory actually exists.
		if _, err := os.Stat(gitRoot); err == nil {
			return true
		}
	}

	return false
}
