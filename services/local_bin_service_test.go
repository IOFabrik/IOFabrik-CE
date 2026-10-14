package services

import (
	"strings"
	"testing"
)

func TestValidateInstalledToolchain(t *testing.T) {
	for _, tt := range []struct {
		name                      string
		git, gh, lfs, busy, valid bool
	}{
		{"complete offline installation", true, true, true, false, true},
		{"missing Git", false, true, true, false, false},
		{"missing gh", true, false, true, false, false},
		{"missing LFS", true, true, false, false, false},
		{"incompatible shell", true, true, true, true, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := validateInstalledToolchain(LocalBinStatus{HasGit: tt.git, HasGh: tt.gh, HasLfs: tt.lfs}, tt.busy)
			if (err == nil) != tt.valid {
				t.Fatalf("unexpected validation: %v", err)
			}
			if err != nil && !strings.Contains(err.Error(), "Reinstall IOFabrik") {
				t.Fatal("missing offline recovery action")
			}
		})
	}
}
