//go:build windows

package services

import (
	"fmt"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows/registry"
)

func TestSyncWindowsInstallRegistryVersionMissingKeyIsNoOp(t *testing.T) {
	missingPath := fmt.Sprintf(`%s-TestMissing-%d-%d`, windowsUninstallRegistryPath, os.Getpid(), time.Now().UnixNano())
	if err := syncWindowsInstallRegistryVersion(missingPath, "1.2.3", `C:\IOFabrik\iofabrik.exe`); err != nil {
		t.Fatalf("syncWindowsInstallRegistryVersion() error = %v", err)
	}
}

func TestSyncWindowsInstallRegistryVersionUpdatesExistingEntry(t *testing.T) {
	path := fmt.Sprintf(`Software\IOFabrik\UpdaterTests-%d-%d`, os.Getpid(), time.Now().UnixNano())
	key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.QUERY_VALUE|registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { key.Close(); registry.DeleteKey(registry.CURRENT_USER, path) })
	if err := key.SetStringValue("DisplayVersion", "0.0.1"); err != nil {
		t.Fatal(err)
	}
	if err := key.SetStringValue("DisplayName", "Updater test fixture"); err != nil {
		t.Fatal(err)
	}
	if err := key.SetStringValue("DisplayIcon", `C:\IOFabrik\iofabrik.exe`); err != nil {
		t.Fatal(err)
	}
	if err := syncWindowsInstallRegistryVersion(path, "0.0.2", `c:\iofabrik\IOFabrik.exe`); err != nil {
		t.Fatal(err)
	}
	version, _, err := key.GetStringValue("DisplayVersion")
	if err != nil || version != "0.0.2" {
		t.Fatalf("DisplayVersion = %q, err = %v", version, err)
	}
	name, _, err := key.GetStringValue("DisplayName")
	if err != nil || name != "Updater test fixture" {
		t.Fatalf("DisplayName changed: %q, err = %v", name, err)
	}
}

func TestSyncWindowsInstallRegistryVersionPreservesSeparateLegacyInstall(t *testing.T) {
	path := fmt.Sprintf(`Software\IOFabrik\UpdaterLegacyTests-%d-%d`, os.Getpid(), time.Now().UnixNano())
	key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.QUERY_VALUE|registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { key.Close(); registry.DeleteKey(registry.CURRENT_USER, path) })
	for name, value := range map[string]string{
		"DisplayVersion": "0.0.1",
		"DisplayIcon":    `C:\Custom\ControlZebra\control-zebra.exe`,
	} {
		if err := key.SetStringValue(name, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := syncWindowsInstallRegistryVersion(path, "0.0.2", `C:\IOFabrik\iofabrik.exe`); err != nil {
		t.Fatal(err)
	}
	version, _, err := key.GetStringValue("DisplayVersion")
	if err != nil || version != "0.0.1" {
		t.Fatalf("separate install version changed: %q, %v", version, err)
	}
}
