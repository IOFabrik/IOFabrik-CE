package services

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	canonicalAppDirName   = "IOFabrik"
	previousAppDirName    = "ControlZebra"
	legacyAppDirName      = "control-zebra"
	configSubDirName      = "config"
	repositoriesSubDir    = "repositories"
	logsSubDirName        = "logs"
	cacheSubDirName       = "cache"
	integrationSubDirName = "integration"
	toolsSubDirName       = "tools"
	binSubDirName         = "bin"
	webview2SubDirName    = "webview2"
	migrationSubDirName   = "migrations"
	migrationMarkerNameV3 = "data-layout-v3.json"
)

// DataLocations describes where IOFabrik stores app data by class.
// RoamingConfigDir retains its binding name; on Windows config is now local.
type DataLocations struct {
	RoamingConfigDir       string `json:"roamingConfigDir"`
	SettingsFile           string `json:"settingsFile"`
	RepositorySettingsDir  string `json:"repositorySettingsDir"`
	LocalDataDir           string `json:"localDataDir"`
	LogsDir                string `json:"logsDir"`
	CacheDir               string `json:"cacheDir"`
	IntegrationDir         string `json:"integrationDir"`
	ToolsBinDir            string `json:"toolsBinDir"`
	WebView2Dir            string `json:"webView2Dir"`
	MigrationMarkerFile    string `json:"migrationMarkerFile"`
	LegacyRoamingConfigDir string `json:"legacyRoamingConfigDir"`
	LegacySettingsFile     string `json:"legacySettingsFile"`
	LegacyRepoSettingsDir  string `json:"legacyRepoSettingsDir"`
	LegacyLogsDir          string `json:"legacyLogsDir"`
	LegacyToolsBinDir      string `json:"legacyToolsBinDir"`
}

func resolveDataLocations() DataLocations {
	return resolveDataLocationsFor(runtime.GOOS, os.Getenv)
}

func resolveDataLocationsFor(goos string, getenv func(string) string) DataLocations {
	userConfigDir := func() string {
		dir, err := os.UserConfigDir()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(dir)
	}
	userCacheDir := func() string {
		dir, err := os.UserCacheDir()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(dir)
	}
	userHomeDir := func() string {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(home)
	}

	roamingBase := ""
	localBase := ""
	home := userHomeDir()

	if goos == "windows" {
		roamingBase = firstNonEmpty(strings.TrimSpace(getenv("APPDATA")), userConfigDir(), filepath.Join(home, "AppData", "Roaming"), ".")
		localBase = firstNonEmpty(strings.TrimSpace(getenv("LOCALAPPDATA")), userCacheDir(), filepath.Join(home, "AppData", "Local"), roamingBase)
	} else {
		roamingBase = firstNonEmpty(userConfigDir(), ".")
		localBase = firstNonEmpty(userCacheDir(), roamingBase)
	}

	roamingConfigDir := filepath.Join(roamingBase, canonicalAppDirName, configSubDirName)
	localDataDir := filepath.Join(localBase, canonicalAppDirName)
	if goos == "windows" {
		roamingConfigDir = filepath.Join(localDataDir, configSubDirName)
	}

	legacyLogsDir := ""
	if home != "" {
		legacyLogsDir = filepath.Join(home, ".config", legacyAppDirName, logsSubDirName)
	}

	return DataLocations{
		RoamingConfigDir:       roamingConfigDir,
		SettingsFile:           filepath.Join(roamingConfigDir, "settings.json"),
		RepositorySettingsDir:  filepath.Join(roamingConfigDir, repositoriesSubDir),
		LocalDataDir:           localDataDir,
		LogsDir:                filepath.Join(localDataDir, logsSubDirName),
		CacheDir:               filepath.Join(localDataDir, cacheSubDirName),
		IntegrationDir:         filepath.Join(localDataDir, integrationSubDirName),
		ToolsBinDir:            filepath.Join(localDataDir, toolsSubDirName, binSubDirName),
		WebView2Dir:            filepath.Join(localDataDir, webview2SubDirName),
		MigrationMarkerFile:    filepath.Join(localDataDir, migrationSubDirName, migrationMarkerNameV3),
		LegacyRoamingConfigDir: filepath.Join(roamingBase, legacyAppDirName),
		LegacySettingsFile:     filepath.Join(roamingBase, legacyAppDirName, "settings.json"),
		LegacyRepoSettingsDir:  filepath.Join(roamingBase, legacyAppDirName, repositoriesSubDir),
		LegacyLogsDir:          legacyLogsDir,
		LegacyToolsBinDir:      filepath.Join(localDataDir, binSubDirName),
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// GetDataLocationsSnapshot returns resolved active and legacy paths.
func GetDataLocationsSnapshot() DataLocations {
	return resolveDataLocations()
}

// RunDataLayoutMigration migrates legacy path layouts to the canonical policy paths.
func RunDataLayoutMigration() error {
	return runDataLayoutMigration(resolveDataLocations())
}

func runDataLayoutMigration(locations DataLocations) error {
	if _, err := os.Stat(locations.MigrationMarkerFile); err == nil {
		return nil
	}

	if err := os.MkdirAll(locations.RoamingConfigDir, 0755); err != nil {
		return fmt.Errorf("failed to ensure roaming config directory: %w", err)
	}
	if err := os.MkdirAll(locations.LogsDir, 0700); err != nil {
		return fmt.Errorf("failed to ensure local logs directory: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(locations.MigrationMarkerFile), 0755); err != nil {
		return fmt.Errorf("failed to ensure migration marker directory: %w", err)
	}

	// Keep registered review workspaces in place. Their records contain absolute
	// paths, and Git also records those paths in the project's worktree registry.
	previousLocal := filepath.Join(filepath.Dir(locations.LocalDataDir), previousAppDirName)
	for _, subdir := range []string{configSubDirName, logsSubDirName, cacheSubDirName, webview2SubDirName, filepath.Join(integrationSubDirName, integrationSessionsSubDir)} {
		if err := mergeDirectoryContents(filepath.Join(previousLocal, subdir), filepath.Join(locations.LocalDataDir, subdir)); err != nil {
			return fmt.Errorf("failed to migrate previous app data: %w", err)
		}
	}
	if !fileExists(filepath.Join(locations.ToolsBinDir, "manifest.json")) {
		for _, subdir := range []string{filepath.Join(toolsSubDirName, binSubDirName), binSubDirName} {
			if err := mergeDirectoryContents(filepath.Join(previousLocal, subdir), locations.ToolsBinDir); err != nil {
				return fmt.Errorf("failed to migrate previous portable tools: %w", err)
			}
		}
	}

	// Prefer previous local settings, then previous roaming settings, then the
	// oldest control-zebra layout. Current destination files always win.
	previousRoamingConfig := filepath.Join(filepath.Dir(locations.LegacyRoamingConfigDir), previousAppDirName, configSubDirName)
	if err := mergeDirectoryContents(previousRoamingConfig, locations.RoamingConfigDir); err != nil {
		return fmt.Errorf("failed to migrate previous roaming config: %w", err)
	}
	previousConfig := filepath.Join(filepath.Dir(locations.LegacyRoamingConfigDir), canonicalAppDirName, configSubDirName)
	if previousConfig != locations.RoamingConfigDir {
		if err := mergeDirectoryContents(previousConfig, locations.RoamingConfigDir); err != nil {
			return fmt.Errorf("failed to migrate previous config: %w", err)
		}
	}
	if err := mergeDirectoryContents(locations.LegacyRoamingConfigDir, locations.RoamingConfigDir); err != nil {
		return fmt.Errorf("failed to migrate roaming config: %w", err)
	}

	if locations.LegacyLogsDir != "" && locations.LegacyLogsDir != locations.LogsDir {
		if err := mergeDirectoryContents(locations.LegacyLogsDir, locations.LogsDir); err != nil {
			return fmt.Errorf("failed to migrate debug logs: %w", err)
		}
	}

	// Wails previously used AppData/<executable name> for the browser profile.
	legacyWebview := filepath.Join(filepath.Dir(locations.LegacyRoamingConfigDir), "control-zebra.exe")
	if err := mergeDirectoryContents(legacyWebview, locations.WebView2Dir); err != nil {
		return fmt.Errorf("failed to migrate browser profile: %w", err)
	}

	if locations.LegacyToolsBinDir != locations.ToolsBinDir && !fileExists(filepath.Join(locations.ToolsBinDir, "manifest.json")) {
		if err := mergeDirectoryContents(locations.LegacyToolsBinDir, locations.ToolsBinDir); err != nil {
			return fmt.Errorf("failed to migrate portable tools: %w", err)
		}
	}

	marker := map[string]interface{}{
		"version":    3,
		"migratedAt": time.Now().UTC().Format(time.RFC3339),
	}
	payload, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to create migration marker: %w", err)
	}
	if err := os.WriteFile(locations.MigrationMarkerFile, payload, 0644); err != nil {
		return fmt.Errorf("failed to write migration marker: %w", err)
	}

	return nil
}

func mergeDirectoryContents(srcDir, dstDir string) error {
	srcInfo, err := os.Stat(srcDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !srcInfo.IsDir() {
		return nil
	}

	if err := os.MkdirAll(dstDir, 0755); err != nil {
		return err
	}

	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(srcDir, entry.Name())
		dstPath := filepath.Join(dstDir, entry.Name())

		if entry.IsDir() {
			if err := mergeDirectoryContents(srcPath, dstPath); err != nil {
				return err
			}
			_ = os.Remove(srcPath)
			continue
		}

		if _, err := os.Stat(dstPath); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return err
		}

		if err := os.Rename(srcPath, dstPath); err == nil {
			continue
		}

		if err := copyFile(srcPath, dstPath); err != nil {
			return err
		}
		_ = os.Remove(srcPath)
	}

	if isDirEmpty(srcDir) {
		_ = os.Remove(srcDir)
	}

	return nil
}

func isDirEmpty(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()

	_, err = f.Readdirnames(1)
	return err == io.EOF
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	info, err := in.Stat()
	if err != nil {
		return err
	}

	// A failed cross-volume copy must not leave a partial destination that a
	// subsequent migration would treat as authoritative.
	out, err := os.CreateTemp(filepath.Dir(dst), ".migration-")
	if err != nil {
		return err
	}
	defer os.Remove(out.Name())
	defer out.Close()
	if err := out.Chmod(fileModeOrDefault(info.Mode(), 0644)); err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(out.Name(), dst)
}

func fileModeOrDefault(mode fs.FileMode, fallback fs.FileMode) fs.FileMode {
	if mode == 0 {
		return fallback
	}
	return mode
}
