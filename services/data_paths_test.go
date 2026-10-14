package services

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveDataLocationsFor_WindowsPolicyPaths(t *testing.T) {
	getenv := func(name string) string {
		switch name {
		case "APPDATA":
			return `C:\Users\tester\AppData\Roaming`
		case "LOCALAPPDATA":
			return `C:\Users\tester\AppData\Local`
		default:
			return ""
		}
	}

	locations := resolveDataLocationsFor("windows", getenv)

	expectedRoaming := filepath.Join(`C:\Users\tester\AppData\Local`, canonicalAppDirName, configSubDirName)
	if locations.RoamingConfigDir != expectedRoaming {
		t.Fatalf("expected roaming dir %q, got %q", expectedRoaming, locations.RoamingConfigDir)
	}

	expectedLocal := filepath.Join(`C:\Users\tester\AppData\Local`, canonicalAppDirName)
	if locations.LocalDataDir != expectedLocal {
		t.Fatalf("expected local data dir %q, got %q", expectedLocal, locations.LocalDataDir)
	}

	expectedTools := filepath.Join(expectedLocal, toolsSubDirName, binSubDirName)
	if locations.ToolsBinDir != expectedTools {
		t.Fatalf("expected tools bin dir %q, got %q", expectedTools, locations.ToolsBinDir)
	}

	expectedLegacy := filepath.Join(`C:\Users\tester\AppData\Roaming`, legacyAppDirName)
	if locations.LegacyRoamingConfigDir != expectedLegacy {
		t.Fatalf("expected legacy roaming dir %q, got %q", expectedLegacy, locations.LegacyRoamingConfigDir)
	}
}

func TestResolveDataLocationsFor_UsesCanonicalName(t *testing.T) {
	getenv := func(name string) string {
		switch name {
		case "APPDATA":
			return `/tmp/roaming`
		case "LOCALAPPDATA":
			return `/tmp/local`
		default:
			return ""
		}
	}

	locations := resolveDataLocationsFor("windows", getenv)

	if filepath.Base(filepath.Dir(locations.RoamingConfigDir)) != canonicalAppDirName {
		t.Fatalf("expected canonical folder name %q in roaming path %q", canonicalAppDirName, locations.RoamingConfigDir)
	}
	if filepath.Base(locations.LocalDataDir) != canonicalAppDirName {
		t.Fatalf("expected canonical folder name %q in local path %q", canonicalAppDirName, locations.LocalDataDir)
	}
}

func TestDataLayoutMigrationPreservesSettingsAndRerunsAfterV1(t *testing.T) {
	root := t.TempDir()
	locations := resolveDataLocationsFor("windows", func(key string) string {
		if key == "APPDATA" {
			return filepath.Join(root, "roaming")
		}
		if key == "LOCALAPPDATA" {
			return filepath.Join(root, "local")
		}
		return ""
	})
	// Never allow a fixture to migrate the real user's historical logs.
	locations.LegacyLogsDir = filepath.Join(root, "old-logs")
	previous := filepath.Join(root, "roaming", canonicalAppDirName, configSubDirName)
	fixtures := map[string]string{
		filepath.Join(root, "roaming", "control-zebra.exe", "profile"):             "browser-session",
		filepath.Join(previous, "settings.json"):                                   "previous-settings",
		filepath.Join(previous, "repositories", "project.json"):                    "repository-settings",
		filepath.Join(locations.LegacyRoamingConfigDir, "settings.json"):           "older-settings",
		filepath.Join(locations.LegacyLogsDir, "debug.log"):                        "log",
		filepath.Join(locations.LocalDataDir, "migrations", "data-layout-v1.json"): "{}",
		filepath.Join(locations.LegacyToolsBinDir, "gh.exe"):                       "old-tool",
		filepath.Join(locations.ToolsBinDir, "gh.exe"):                             "installed-tool",
	}
	for path, content := range fixtures {
		writeMigrationFixture(t, path, content)
	}
	if err := runDataLayoutMigration(locations); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{
		filepath.Join(locations.WebView2Dir, "profile"):                "browser-session",
		locations.SettingsFile:                                         "previous-settings",
		filepath.Join(locations.RepositorySettingsDir, "project.json"): "repository-settings",
		filepath.Join(locations.ToolsBinDir, "gh.exe"):                 "installed-tool",
		filepath.Join(locations.LogsDir, "debug.log"):                  "log",
	} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatalf("%s: got %q, %v; want %q", path, got, err, want)
		}
	}
	writeMigrationFixture(t, locations.SettingsFile, "updated-settings")
	if err := runDataLayoutMigration(locations); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(locations.SettingsFile)
	if string(got) != "updated-settings" {
		t.Fatal("repeat migration overwrote current settings")
	}
}

func TestIOFabrikMigrationPreservesLegacyReviewWorkspace(t *testing.T) {
	root := t.TempDir()
	locations := resolveDataLocationsFor("windows", func(key string) string { return filepath.Join(root, key) })
	locations.LegacyLogsDir = filepath.Join(root, "old-logs")
	previous := filepath.Join(root, "LOCALAPPDATA", "ControlZebra")
	workspace := filepath.Join(previous, "integration", "workspaces", "review")
	fixtures := map[string]string{
		filepath.Join(previous, "config", "settings.json"):                        "previous-local",
		filepath.Join(root, "APPDATA", "ControlZebra", "config", "settings.json"): "previous-roaming",
		filepath.Join(previous, "logs", "debug.log"):                              "previous-log",
		filepath.Join(previous, "cache", "cached-file"):                           "previous-cache",
		filepath.Join(previous, "webview2", "profile"):                            "previous-browser",
		filepath.Join(previous, "integration", "sessions", "review.json"):         workspace,
		filepath.Join(workspace, "decision.txt"):                                  "retained-decision",
		filepath.Join(previous, "migrations", "data-layout-v2.json"):              "{}",
	}
	for path, content := range fixtures {
		writeMigrationFixture(t, path, content)
	}
	if err := runDataLayoutMigration(locations); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{
		locations.SettingsFile:                                             "previous-local",
		filepath.Join(locations.LogsDir, "debug.log"):                      "previous-log",
		filepath.Join(locations.CacheDir, "cached-file"):                   "previous-cache",
		filepath.Join(locations.WebView2Dir, "profile"):                    "previous-browser",
		filepath.Join(locations.IntegrationDir, "sessions", "review.json"): workspace,
		filepath.Join(workspace, "decision.txt"):                           "retained-decision",
	} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatalf("migration changed retained data: %s: %q, %v", path, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(locations.IntegrationDir, "workspaces", "review")); !os.IsNotExist(err) {
		t.Fatalf("registered workspace moved: %v", err)
	}
}

func TestDataLayoutMigrationKeepsCurrentSettings(t *testing.T) {
	root := t.TempDir()
	locations := resolveDataLocationsFor("windows", func(key string) string { return filepath.Join(root, key) })
	locations.LegacyLogsDir = filepath.Join(root, "old-logs")
	writeMigrationFixture(t, locations.SettingsFile, "current")
	writeMigrationFixture(t, filepath.Join(root, "APPDATA", canonicalAppDirName, configSubDirName, "settings.json"), "previous")
	if err := runDataLayoutMigration(locations); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(locations.SettingsFile)
	if string(got) != "current" {
		t.Fatal("migration overwrote destination")
	}
}

func writeMigrationFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestMigrationDoesNotMixLegacyToolsIntoInstallerBundle(t *testing.T) {
	root := t.TempDir()
	locations := resolveDataLocationsFor("windows", func(key string) string { return filepath.Join(root, key) })
	locations.LegacyLogsDir = filepath.Join(root, "old-logs")
	writeMigrationFixture(t, filepath.Join(locations.ToolsBinDir, "manifest.json"), "{}")
	writeMigrationFixture(t, filepath.Join(locations.ToolsBinDir, "gh", "bin", "gh.exe"), "new")
	writeMigrationFixture(t, filepath.Join(locations.LegacyToolsBinDir, "gh.exe"), "old")
	if err := runDataLayoutMigration(locations); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(locations.ToolsBinDir, "gh.exe")); !os.IsNotExist(err) {
		t.Fatal("old CLI would shadow bundled CLI")
	}
}
