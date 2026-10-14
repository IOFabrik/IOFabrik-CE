// Package services provides backend functionality for the IOFabrik application.
// This file contains the CLI resolver which locates managed/local git, gh,
// and git-lfs binaries. On Windows, user-level managed binaries in
// %LOCALAPPDATA%\IOFabrik\tools\bin are preferred.
package services

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

var (
	resolvedGit string
	resolvedGh  string
	resolvedLfs string
	resolveOnce sync.Once
	resolveMu   sync.Mutex
)

// resolveCLIPaths runs once on first call and caches the resolved paths.
// Resolution order:
//  1. Platform-local managed binaries (Windows AppData bin).
//  2. Bundled app resources (macOS bundle).
//  3. System PATH lookup via exec.LookPath.
//  4. Bare command name fallback so exec.Command does its own lookup.
func resolveCLIPaths() {
	resolveMu.Lock()
	defer resolveMu.Unlock()

	resolveOnce.Do(func() {
		execPath, err := os.Executable()
		if err != nil {
			log.Printf("[cli_resolver] could not determine executable path: %v", err)
		} else {
			// Resolve symlinks so we get the real location inside the .app / install dir.
			// If this fails (common on some Windows install/update flows), continue with
			// the original executable path instead of aborting CLI resolution.
			if resolvedExecPath, resolveErr := filepath.EvalSymlinks(execPath); resolveErr != nil {
				log.Printf("[cli_resolver] could not resolve symlinks (continuing with raw executable path): %v", resolveErr)
			} else {
				execPath = resolvedExecPath
			}
		}

		execDir := ""
		if strings.TrimSpace(execPath) != "" {
			execDir = filepath.Dir(execPath)
		}

		switch runtime.GOOS {
		case "darwin":
			// macOS .app bundle layout:
			//   Contents/MacOS/iofabrik        ← execDir
			//   Contents/Resources/git/bin/git
			//   Contents/Resources/gh/bin/gh
			resourcesDir := filepath.Join(execDir, "..", "Resources")
			tryResolve(&resolvedGit, filepath.Join(resourcesDir, "git", "bin", "git"))
			tryResolve(&resolvedGh, filepath.Join(resourcesDir, "gh", "bin", "gh"))
			tryResolve(&resolvedLfs, filepath.Join(resourcesDir, "git", "bin", "git-lfs"))

		case "windows":
			// First priority: user-managed portable binaries in LOCALAPPDATA.
			tryResolveMany(&resolvedGit, localManagedGitPathCandidates()...)
			tryResolveMany(&resolvedGh, localManagedGhPathCandidates()...)
			tryResolveMany(&resolvedLfs, localManagedLfsPathCandidates()...)
		}

		// Fall back to system PATH
		if resolvedGit == "" {
			if p, err := exec.LookPath("git"); err == nil {
				resolvedGit = p
			}
		}
		if resolvedGh == "" {
			if p, err := exec.LookPath("gh"); err == nil {
				resolvedGh = p
			}
		}
		if resolvedLfs == "" {
			if p, err := exec.LookPath("git-lfs"); err == nil {
				resolvedLfs = p
			}
		}

		// Windows fallback: discover common install paths even when PATH is not
		// inherited correctly (for example, app launched from Explorer before PATH refresh).
		if runtime.GOOS == "windows" {
			if resolvedGit == "" {
				tryResolveMany(&resolvedGit, commonWindowsGitPaths()...)
			}
			if resolvedGh == "" {
				tryResolveMany(&resolvedGh, commonWindowsGhPaths()...)
			}
			if resolvedLfs == "" {
				tryResolveMany(&resolvedLfs, commonWindowsLfsPaths()...)
			}
		}

		log.Printf("[cli_resolver] git → %s", cliLabel(resolvedGit, "git"))
		log.Printf("[cli_resolver] gh  → %s", cliLabel(resolvedGh, "gh"))
		log.Printf("[cli_resolver] lfs → %s", cliLabel(resolvedLfs, "git-lfs"))
	})
}

// GitPath returns the absolute path to the git binary when resolved.
// If neither is found it returns the bare "git" string so exec.Command
// performs its own PATH lookup (and produces a clear error on failure).
func GitPath() string {
	resolveCLIPaths()
	if resolvedGit != "" {
		return resolvedGit
	}
	return "git"
}

// GhPath returns the absolute path to the gh CLI binary when resolved.
func GhPath() string {
	resolveCLIPaths()
	if resolvedGh != "" {
		return resolvedGh
	}
	return "gh"
}

// LfsPath returns the absolute path to git-lfs when available.
func LfsPath() string {
	resolveCLIPaths()
	if resolvedLfs != "" {
		return resolvedLfs
	}
	return "git-lfs"
}

// RefreshCLIPaths clears the cached resolver state and resolves again.
// Use this after installing/updating managed binaries at runtime.
func RefreshCLIPaths() {
	resolveMu.Lock()
	resolvedGit = ""
	resolvedGh = ""
	resolvedLfs = ""
	resolveOnce = sync.Once{}
	resolveMu.Unlock()
	resolveCLIPaths()
}

// ---------- helpers ----------

func tryResolve(target *string, candidate string) {
	if *target != "" || strings.TrimSpace(candidate) == "" {
		return
	}
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		*target = candidate
	}
}

func tryResolveMany(target *string, candidates ...string) {
	for _, candidate := range candidates {
		tryResolve(target, candidate)
		if *target != "" {
			return
		}
	}
}

func commonWindowsGitPaths() []string {
	paths := make([]string, 0, 8)

	appendGitPaths := func(base string) {
		if strings.TrimSpace(base) == "" {
			return
		}
		paths = append(paths,
			filepath.Join(base, "Git", "cmd", "git.exe"),
			filepath.Join(base, "Git", "bin", "git.exe"),
		)
	}

	appendGitPaths(os.Getenv("ProgramFiles"))
	appendGitPaths(os.Getenv("ProgramFiles(x86)"))
	appendGitPaths(filepath.Join(os.Getenv("LocalAppData"), "Programs"))

	if userProfile := os.Getenv("UserProfile"); strings.TrimSpace(userProfile) != "" {
		paths = append(paths,
			filepath.Join(userProfile, "scoop", "apps", "git", "current", "cmd", "git.exe"),
			filepath.Join(userProfile, "scoop", "apps", "git", "current", "bin", "git.exe"),
		)
	}

	return paths
}

func commonWindowsGhPaths() []string {
	paths := make([]string, 0, 8)

	appendGhPaths := func(base string) {
		if strings.TrimSpace(base) == "" {
			return
		}
		paths = append(paths,
			filepath.Join(base, "GitHub CLI", "gh.exe"),
			filepath.Join(base, "GitHub CLI", "bin", "gh.exe"),
		)
	}

	appendGhPaths(os.Getenv("ProgramFiles"))
	appendGhPaths(os.Getenv("ProgramFiles(x86)"))
	appendGhPaths(filepath.Join(os.Getenv("LocalAppData"), "Programs"))

	if userProfile := os.Getenv("UserProfile"); strings.TrimSpace(userProfile) != "" {
		paths = append(paths,
			filepath.Join(userProfile, "scoop", "apps", "gh", "current", "bin", "gh.exe"),
			filepath.Join(userProfile, "scoop", "apps", "gh", "current", "gh.exe"),
		)
	}

	return paths
}

func commonWindowsLfsPaths() []string {
	paths := make([]string, 0, 8)

	appendLfsPaths := func(base string) {
		if strings.TrimSpace(base) == "" {
			return
		}
		paths = append(paths,
			filepath.Join(base, "Git", "bin", "git-lfs.exe"),
			filepath.Join(base, "Git", "mingw64", "bin", "git-lfs.exe"),
		)
	}

	appendLfsPaths(os.Getenv("ProgramFiles"))
	appendLfsPaths(os.Getenv("ProgramFiles(x86)"))
	appendLfsPaths(filepath.Join(os.Getenv("LocalAppData"), "Programs"))

	if userProfile := os.Getenv("UserProfile"); strings.TrimSpace(userProfile) != "" {
		paths = append(paths,
			filepath.Join(userProfile, "scoop", "apps", "git-lfs", "current", "git-lfs.exe"),
		)
	}

	return paths
}

func cliLabel(resolved, fallback string) string {
	if resolved != "" {
		return resolved
	}
	return fallback + " (PATH)"
}
