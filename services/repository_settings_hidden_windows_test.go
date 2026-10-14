//go:build windows

package services

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestRepositorySettingsServiceHiddenDirectory(t *testing.T) {
	operations := []struct {
		name string
		run  func(*RepositorySettingsService, string) OperationResult
	}{
		{"ensure", (*RepositorySettingsService).EnsureIOFabrikDir},
		{"shared_config", func(s *RepositorySettingsService, path string) OperationResult {
			return s.WriteRepoLocalConfig(path, RepoLocalConfig{AppVersion: "test"})
		}},
		{"personal_config", func(s *RepositorySettingsService, path string) OperationResult {
			return s.WriteRepoPersonalConfig(path, RepoPersonalConfig{LocalOnlyMode: true})
		}},
	}
	for _, operation := range operations {
		for _, state := range []string{"new", "existing_visible", "existing_hidden"} {
			t.Run(operation.name+"/"+state, func(t *testing.T) {
				repoPath := filepath.Join(t.TempDir(), "project with spaces 日本語")
				if err := os.Mkdir(repoPath, 0755); err != nil {
					t.Fatal(err)
				}
				dirPath := iofabrikDirPath(repoPath)
				var before uint32
				var childAttrs uint32
				var nestedAttrs uint32
				childPath := filepath.Join(dirPath, "existing.txt")
				subdirPath := filepath.Join(dirPath, "existing-subdirectory")
				nestedPath := filepath.Join(subdirPath, "already-hidden.txt")
				if state != "new" {
					if err := os.Mkdir(dirPath, 0755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(childPath, []byte("keep this content"), 0644); err != nil {
						t.Fatal(err)
					}
					childAttrs = hiddenTestAttributes(t, childPath)
					if err := os.Mkdir(subdirPath, 0755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(nestedPath, []byte("nested content"), 0644); err != nil {
						t.Fatal(err)
					}
					nestedAttrs = hiddenTestAttributes(t, nestedPath) | windows.FILE_ATTRIBUTE_HIDDEN
					nestedPtr, err := windows.UTF16PtrFromString(nestedPath)
					if err != nil {
						t.Fatal(err)
					}
					if err := windows.SetFileAttributes(nestedPtr, nestedAttrs); err != nil {
						t.Fatal(err)
					}
					before = hiddenTestAttributes(t, dirPath) | windows.FILE_ATTRIBUTE_NOT_CONTENT_INDEXED
					if state == "existing_hidden" {
						before |= windows.FILE_ATTRIBUTE_HIDDEN
					}
					path, err := windows.UTF16PtrFromString(dirPath)
					if err != nil {
						t.Fatal(err)
					}
					if err := windows.SetFileAttributes(path, before); err != nil {
						t.Fatal(err)
					}
				}

				service := &RepositorySettingsService{}
				for attempt := 0; attempt < 2; attempt++ {
					result := operation.run(service, repoPath)
					if !result.Success {
						t.Fatalf("operation failed: %s", result.Error)
					}
					attrs := hiddenTestAttributes(t, dirPath)
					wantHidden := state != "existing_visible"
					if gotHidden := attrs&windows.FILE_ATTRIBUTE_HIDDEN != 0; gotHidden != wantHidden {
						t.Errorf(".iofabrik Hidden attribute: got %v, want %v (%#x)", gotHidden, wantHidden, attrs)
					}
					if state != "new" && attrs != before {
						t.Errorf("existing directory attributes changed: before=%#x after=%#x", before, attrs)
					}
					entries, err := os.ReadDir(dirPath)
					if err != nil {
						t.Fatal(err)
					}
					for _, entry := range entries {
						if hiddenTestAttributes(t, filepath.Join(dirPath, entry.Name()))&windows.FILE_ATTRIBUTE_HIDDEN != 0 {
							t.Errorf("child %s was unexpectedly hidden", entry.Name())
						}
					}
					if state != "new" {
						if got := hiddenTestAttributes(t, nestedPath); got != nestedAttrs {
							t.Errorf("nested child attributes changed: before=%#x after=%#x", nestedAttrs, got)
						}
						if got := hiddenTestAttributes(t, childPath); got != childAttrs {
							t.Errorf("child attributes changed: before=%#x after=%#x", childAttrs, got)
						}
						data, err := os.ReadFile(childPath)
						if err != nil || string(data) != "keep this content" {
							t.Fatalf("existing child content changed: %q, %v", data, err)
						}
					}
				}
			})
		}
	}
}

func TestRepositorySettingsServiceUnhiddenDirectory(t *testing.T) {
	repoPath := t.TempDir()
	service := &RepositorySettingsService{}
	if result := service.EnsureIOFabrikDir(repoPath); !result.Success {
		t.Fatal(result.Error)
	}
	dirPath := iofabrikDirPath(repoPath)
	attrs := hiddenTestAttributes(t, dirPath) &^ windows.FILE_ATTRIBUTE_HIDDEN
	path, err := windows.UTF16PtrFromString(dirPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetFileAttributes(path, attrs); err != nil {
		t.Fatal(err)
	}
	for _, result := range []OperationResult{
		service.EnsureIOFabrikDir(repoPath),
		service.WriteRepoLocalConfig(repoPath, RepoLocalConfig{}),
		service.WriteRepoPersonalConfig(repoPath, RepoPersonalConfig{}),
	} {
		if !result.Success {
			t.Fatal(result.Error)
		}
		if got := hiddenTestAttributes(t, dirPath); got != attrs {
			t.Errorf("manually unhidden directory attributes changed: before=%#x after=%#x", attrs, got)
		}
	}
}

func hiddenTestAttributes(t *testing.T, path string) uint32 {
	t.Helper()
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	attrs, err := windows.GetFileAttributes(ptr)
	if err != nil {
		t.Fatal(err)
	}
	return attrs
}
