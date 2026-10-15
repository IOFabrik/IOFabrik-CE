//go:build windows

package services

import (
	"fmt"
	"os"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

func lockPreviewFile(file *os.File, exclusive bool) error {
	flags := uint32(windows.LOCKFILE_FAIL_IMMEDIATELY)
	if exclusive {
		flags |= windows.LOCKFILE_EXCLUSIVE_LOCK
	}
	return windows.LockFileEx(windows.Handle(file.Fd()), flags, 0, 1, 0, &windows.Overlapped{})
}

func previewFileIdentity(path string) (string, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(p, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return "", err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return "", fmt.Errorf("linked path")
	}
	return fmt.Sprintf("%x:%x:%x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), nil
}

func setPreviewHidden(path string) error {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	attributes, err := windows.GetFileAttributes(p)
	if err != nil {
		return err
	}
	return windows.SetFileAttributes(p, attributes|windows.FILE_ATTRIBUTE_HIDDEN)
}

func previewPlatformReady() error {
	if runtime.GOARCH != "amd64" {
		return fmt.Errorf("Windows x64 is required")
	}
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return err
	}
	defer windows.CloseServiceHandle(manager)
	name, _ := windows.UTF16PtrFromString("LdSdkService")
	service, err := windows.OpenService(manager, name, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		return err
	}
	defer windows.CloseServiceHandle(service)
	var status windows.SERVICE_STATUS
	if err := windows.QueryServiceStatus(service, &status); err != nil {
		return err
	}
	if status.CurrentState != windows.SERVICE_RUNNING {
		return fmt.Errorf("SDK service is stopped")
	}
	return nil
}

// Windows assigns a new identifier on boot. Unlike wall-clock/uptime
// arithmetic this remains reliable when the user adjusts the clock.
func previewBootID() (string, error) {
	var environment [32]byte
	var length uint32
	err := windows.NtQuerySystemInformation(windows.SystemBootEnvironmentInformation,
		unsafe.Pointer(&environment[0]), uint32(len(environment)), &length)
	if err != nil {
		return "", err
	}
	if length < 16 {
		return "", fmt.Errorf("missing boot identity")
	}
	return fmt.Sprintf("%x", environment[:16]), nil
}
