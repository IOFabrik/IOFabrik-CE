package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveUsesSelectedDefaultWithoutRedirectingActiveBranch(t *testing.T) {
	for _, branch := range []string{"trunk", "release/2026", "main", "master", "Release/2026"} {
		t.Run(branch, func(t *testing.T) {
			repo := defaultBranchTestRepo(t, "trunk", "release/2026", "master", "Release/2026")
			settings := NewRepositorySettingsService()
			if result := settings.SetProjectDefaultBranch(repo, branch); !result.Success {
				t.Fatal(result.Error)
			}
			// main is deliberately the work branch when another default is selected.
			before := strings.TrimSpace(runGitOutput(t, repo, "rev-parse", "HEAD"))
			if err := os.WriteFile(filepath.Join(repo, "logic.L5X"), []byte("pending work"), 0644); err != nil {
				t.Fatal(err)
			}
			if result := NewGitService().CommitAll(repo, "Save active work"); !result.Success {
				t.Fatal(result.Error)
			}
			if got := strings.TrimSpace(runGitOutput(t, repo, "branch", "--show-current")); got != "main" {
				t.Fatalf("Save switched branches: %s", got)
			}
			if branch != "main" && strings.TrimSpace(runGitOutput(t, repo, "rev-parse", branch)) != before {
				t.Fatal("Save changed the selected default instead of the active branch")
			}
		})
	}
}

func TestSaveReadinessRejectsMutationWithoutLosingWork(t *testing.T) {
	for _, mode := range []string{"unresolved", "deleted", "detached", "case-mismatch"} {
		for _, staged := range []bool{false, true} {
			t.Run(mode+map[bool]string{false: "/CommitAll", true: "/Commit"}[staged], func(t *testing.T) {
				repo := defaultBranchTestRepo(t, "trunk")
				settings := NewRepositorySettingsService()
				if mode != "unresolved" {
					if result := settings.SetProjectDefaultBranch(repo, "trunk"); !result.Success {
						t.Fatal(result.Error)
					}
				}
				if mode == "deleted" {
					runGitCmd(t, repo, "branch", "-D", "trunk")
				}
				if mode == "detached" {
					runGitCmd(t, repo, "checkout", "--detach")
				}
				if mode == "case-mismatch" {
					runGitCmd(t, repo, "branch", "-m", "trunk", "Trunk")
				}
				file := filepath.Join(repo, "logic.L5X")
				if err := os.WriteFile(file, []byte("pending work"), 0644); err != nil {
					t.Fatal(err)
				}
				if staged {
					runGitCmd(t, repo, "add", ".")
				}
				beforeHead := runGitOutput(t, repo, "rev-parse", "HEAD")
				beforeIndex := runGitOutput(t, repo, "diff", "--cached")
				service := NewGitService()
				var result OperationResult
				if staged {
					result = service.Commit(repo, "Keep this message")
				} else {
					result = service.CommitAll(repo, "Keep this message")
				}
				if result.Success || result.Error == "" {
					t.Fatalf("Save bypassed readiness: %+v", result)
				}
				if runGitOutput(t, repo, "rev-parse", "HEAD") != beforeHead || runGitOutput(t, repo, "diff", "--cached") != beforeIndex {
					t.Fatal("blocked Save changed the snapshot or staging")
				}
				if contents, err := os.ReadFile(file); err != nil || string(contents) != "pending work" {
					t.Fatal("blocked Save lost unsaved work")
				}
			})
		}
	}
}

func TestSaveWithCachedAutomaticDefaultIsOffline(t *testing.T) {
	repo := defaultBranchTestRepo(t, "release/2026")
	runGitCmd(t, repo, "remote", "add", "origin", "https://github.com/factory/project.git")
	settings := NewRepositorySettingsService()
	fakeProjectDefault(t, "factory/project", "release/2026")
	assertProjectDefault(t, settings.RefreshProjectDefaultBranch(repo), "release/2026", ProjectDefaultAutomatic)
	installFakeGh(t, "#!/bin/sh\nexit 1\n")
	if err := os.WriteFile(filepath.Join(repo, "logic.L5X"), []byte("offline work"), 0644); err != nil {
		t.Fatal(err)
	}
	if result := NewGitService().CommitAll(repo, "Save offline"); !result.Success {
		t.Fatal(result.Error)
	}
	assertProjectDefault(t, settings.GetProjectDefaultBranch(repo), "release/2026", ProjectDefaultAutomatic)
}

func TestSaveInitializedUnbornProject(t *testing.T) {
	repo := t.TempDir()
	service := NewGitService()
	if result := service.InitRepo(repo); !result.Success {
		t.Fatal(result.Error)
	}
	runGitCmd(t, repo, "config", "user.name", "Test User")
	runGitCmd(t, repo, "config", "user.email", "test@example.com")
	if result := service.CommitAll(repo, "First Save"); !result.Success {
		t.Fatal(result.Error)
	}
	if got := strings.TrimSpace(runGitOutput(t, repo, "log", "--format=%s")); got != "First Save" {
		t.Fatalf("unexpected first Save: %s", got)
	}
}
