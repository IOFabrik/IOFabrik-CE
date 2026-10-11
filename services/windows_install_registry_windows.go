//go:build windows

package services

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows/registry"
)

// wails_tools.nsh defines UNINST_KEY_NAME as
// ${INFO_COMPANYNAME}${INFO_PRODUCTNAME}; both generated values are IOFabrik.
const windowsUninstallRegistryPath = `Software\Microsoft\Windows\CurrentVersion\Uninstall\IOFabrikIOFabrik`
const legacyWindowsUninstallRegistryPath = `Software\Microsoft\Windows\CurrentVersion\Uninstall\ControlZebraControlZebra`

// SyncWindowsInstallRegistryVersion keeps Windows' Installed Apps entry in
// sync after the Wails updater replaces the executable in place. A missing
// NSIS uninstall entry means this was not an installed copy and is a no-op.
func SyncWindowsInstallRegistryVersion(version string) error {
	if !AppUpdatesEnabled() {
		return nil
	}
	var failures []error
	for _, path := range []string{windowsUninstallRegistryPath, legacyWindowsUninstallRegistryPath} {
		if err := syncWindowsInstallRegistryVersion(path, normalizeAppVersion(version)); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func syncWindowsInstallRegistryVersion(path, version string) error {
	key, err := registry.OpenKey(
		registry.CURRENT_USER,
		path,
		registry.QUERY_VALUE|registry.SET_VALUE|registry.WOW64_64KEY,
	)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open uninstall registry key: %w", err)
	}
	defer key.Close()

	if err := key.SetStringValue("DisplayVersion", version); err != nil {
		return fmt.Errorf("update uninstall DisplayVersion: %w", err)
	}
	return nil
}
