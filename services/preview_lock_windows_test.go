//go:build windows

package services

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreviewRunnerPreservesNativeSDKProfile(t *testing.T) {
	native := filepath.Dir(filepath.Dir(platformPreviewStateDirectory()))
	t.Setenv("LOCALAPPDATA", t.TempDir())
	runner := NewCommandRunner()
	runner.previewOwner = true
	command := runner.prepare(context.Background(), "", "unused-helper.exe", nil)
	for _, value := range command.Env {
		if key, value, ok := strings.Cut(value, "="); ok && strings.EqualFold(key, "LOCALAPPDATA") {
			if value != native {
				t.Fatalf("SDK inherited redirected profile: %q", value)
			}
			return
		}
	}
	t.Fatal("SDK profile missing")
}
