//go:build !windows

package services

import (
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
)

func platformPreviewStateDirectory() string {
	return filepath.Join(GetDataLocationsSnapshot().LocalDataDir, "LDSDK")
}

func lockPreviewFile(file *os.File, exclusive bool) error {
	mode := unix.LOCK_SH
	if exclusive {
		mode = unix.LOCK_EX
	}
	return unix.Flock(int(file.Fd()), mode|unix.LOCK_NB)
}

func previewFileIdentity(path string) (string, error) {
	var info unix.Stat_t
	if err := unix.Lstat(path, &info); err != nil {
		return "", err
	}
	if info.Mode&unix.S_IFMT == unix.S_IFLNK {
		return "", fmt.Errorf("linked path")
	}
	return fmt.Sprintf("%x:%x", info.Dev, info.Ino), nil
}

func setPreviewHidden(string) error { return nil }

func previewPlatformReady() error    { return fmt.Errorf("Windows x64 is required") }
func previewBootID() (string, error) { return "test-boot", nil }
