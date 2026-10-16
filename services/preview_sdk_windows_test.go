//go:build windows

package services

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// Explicit opt-in: this exercises the installed SDK and its native per-user
// recovery storage. It never removes an existing interruption record.
func TestPreviewWindowsSDKIntegration(t *testing.T) {
	source := os.Getenv("LDSDK_TEST_SOURCE")
	helper := os.Getenv("LDSDK_TEST_HELPER_DIR")
	if source == "" || helper == "" {
		t.Skip("set LDSDK_TEST_SOURCE and LDSDK_TEST_HELPER_DIR for real Windows SDK testing")
	}
	if err := verifyPreviewHelper(helper); err != nil {
		t.Fatal(err)
	}
	s := NewPreviewGenerationService()
	for _, name := range []string{"app-inflight.json", "sdk-interrupted.json"} {
		if _, err := os.Lstat(filepath.Join(s.stateDir, name)); !os.IsNotExist(err) {
			t.Fatalf("SDK recovery state must be settled before testing: %s (%v)", name, err)
		}
	}
	s.resolveHelper = func() (string, error) { return filepath.Join(helper, "LDSDK.Helper.exe"), nil }
	root := createTestRepo(t)
	t.Cleanup(func() { cleanupTestRepo(t, root) })
	selected := filepath.Join(root, "Controller.ACD")
	if err := copyFile(source, selected); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		".gitignore":     "*.ACD\n",
		".gitattributes": "* text=auto eol=crlf\n*.xml text eol=crlf ident\n",
		"notes.txt":      "unrelated staged content\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	runGitCmd(t, root, "add", ".")
	hash := func(path string) string {
		t.Helper()
		value, err := previewHashFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	sourceHash, indexHash := hash(source), hash(filepath.Join(root, ".git", "index"))
	destination := filepath.Join(root, "Controller.preview")
	for attempt := 0; attempt < 2; attempt++ {
		requirePreviewSuccess(t, generateTestPreview(t, s, root, selected))
		if hash(source) != sourceHash || hash(selected) != sourceHash || hash(filepath.Join(root, ".git", "index")) != indexHash {
			t.Fatal("generation changed the fixture, selected source, or unrelated staging")
		}
		path, err := windows.UTF16PtrFromString(destination)
		if err != nil {
			t.Fatal(err)
		}
		attributes, err := windows.GetFileAttributes(path)
		if err != nil || attributes&windows.FILE_ATTRIBUTE_HIDDEN == 0 {
			t.Fatalf("preview is not hidden: %v", err)
		}
		if attempt == 0 {
			if err := os.WriteFile(filepath.Join(destination, "notes.txt"), []byte("keep me"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if notes, err := os.ReadFile(filepath.Join(destination, "notes.txt")); err != nil || string(notes) != "keep me" {
		t.Fatalf("regeneration lost unrelated preview content: %v", err)
	}
	for _, name := range []string{"app-inflight.json", "sdk-interrupted.json"} {
		if _, err := os.Lstat(filepath.Join(s.stateDir, name)); !os.IsNotExist(err) {
			t.Fatalf("SDK recovery state remains after successful generation: %s (%v)", name, err)
		}
	}
	t.Log("Real SDK generation and regeneration preserved source/index bytes, unrelated content, and Hidden attributes")
}
