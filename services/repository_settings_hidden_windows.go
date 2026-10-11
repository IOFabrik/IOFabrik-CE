//go:build windows

package services

import "golang.org/x/sys/windows"

// Hide only the directory itself, retaining its other attributes and leaving
// child files and directories untouched.
func hideIOFabrikDirectory(dirPath string) error {
	path, err := windows.UTF16PtrFromString(dirPath)
	if err != nil {
		return err
	}
	attributes, err := windows.GetFileAttributes(path)
	if err != nil {
		return err
	}
	if attributes&windows.FILE_ATTRIBUTE_HIDDEN != 0 {
		return nil
	}
	return windows.SetFileAttributes(path, attributes|windows.FILE_ATTRIBUTE_HIDDEN)
}
