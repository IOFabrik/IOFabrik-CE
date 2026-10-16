//go:build windows

package services

import (
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func platformPreviewStateDirectory() string {
	root, err := windows.KnownFolderPath(windows.FOLDERID_LocalAppData, 0)
	if err != nil {
		return ""
	}
	return filepath.Join(root, "IOFabrik", "LDSDK")
}

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

// The environment GUID can survive a Windows restart. Combine it with the
// kernel's latest startup event record, which is stable during this boot and
// independent of wall-clock adjustments. Missing/cleared evidence fails closed.
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
	systemDirectory, err := windows.GetSystemDirectory()
	if err != nil {
		return "", err
	}
	runner := NewCommandRunner()
	runner.previewOwner = true
	result := runner.Run("", filepath.Join(systemDirectory, "wevtutil.exe"), "qe", "System",
		"/q:*[System[Provider[@Name='Microsoft-Windows-Kernel-General'] and EventID=12]]",
		"/rd:true", "/c:1", "/f:xml", "/uni:false")
	if !result.Success || len(result.Stdout) > 65536 {
		return "", fmt.Errorf("cannot read kernel startup evidence")
	}
	decoder := xml.NewDecoder(strings.NewReader(result.Stdout))
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "Event" {
			continue
		}
		var event struct {
			System struct {
				Provider struct {
					Name string `xml:"Name,attr"`
				}
				EventID       uint32
				EventRecordID uint64
			}
		}
		if err := decoder.DecodeElement(&event, &start); err != nil {
			return "", err
		}
		if event.System.Provider.Name != "Microsoft-Windows-Kernel-General" || event.System.EventID != 12 || event.System.EventRecordID == 0 {
			return "", fmt.Errorf("invalid kernel startup evidence")
		}
		return fmt.Sprintf("kernel-event-v1:%x:%s", environment[:16], strconv.FormatUint(event.System.EventRecordID, 10)), nil
	}
	return "", fmt.Errorf("missing kernel startup evidence")
}
