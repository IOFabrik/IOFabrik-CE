package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func defaultBranchTestRepo(t *testing.T, branches ...string) string {
	t.Helper()
	repo := createTestRepo(t)
	t.Cleanup(func() { cleanupTestRepo(t, repo) })
	runGitCmd(t, repo, "symbolic-ref", "HEAD", "refs/heads/main")
	runGitCmd(t, repo, "commit", "--allow-empty", "-m", "initial")
	for _, branch := range branches {
		runGitCmd(t, repo, "branch", branch)
	}
	return repo
}

func fakeProjectDefault(t *testing.T, repository, branch string) {
	t.Helper()
	installFakeGh(t, fmt.Sprintf(`#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" != "repo" ] || [ "$2" != "view" ] || [ "$3" != "%s" ] || [ "$4" != "--json" ] || [ "$5" != "nameWithOwner,defaultBranchRef" ]; then
  echo 'unexpected repository selection' >&2; exit 1
fi
printf '%%s\n' '{"nameWithOwner":"%s","defaultBranchRef":{"name":"%s"}}'
`, repository, repository, branch))
}

func assertProjectDefault(t *testing.T, got ProjectDefaultBranchResult, branch string, mode ProjectDefaultBranchMode) {
	t.Helper()
	availability := ProjectDefaultReady
	if branch == "" {
		availability = ProjectDefaultNeedsSelection
	}
	if got.EffectiveBranch != branch || got.Mode != mode || got.Availability != availability {
		t.Fatalf("unexpected default: %+v; want branch %q, mode %s, availability %s", got, branch, mode, availability)
	}
}

func TestProjectDefaultBranchExplicitOrigin(t *testing.T) {
	for _, branch := range []string{"trunk", "release/2026", "main", "master", "Release/2026"} {
		t.Run(branch, func(t *testing.T) {
			repo := defaultBranchTestRepo(t)
			if branch != "main" {
				runGitCmd(t, repo, "branch", branch)
			}
			runGitCmd(t, repo, "remote", "add", "upstream", "https://github.com/other/decoy.git")
			runGitCmd(t, repo, "remote", "add", "origin", "git@github.com:factory/project.git")
			fakeProjectDefault(t, "factory/project", branch)
			service := NewRepositorySettingsService()
			got := service.RefreshProjectDefaultBranch(repo)
			assertProjectDefault(t, got, branch, ProjectDefaultAutomatic)
			if got.LookupStatus != "github" || got.OriginRepository != "factory/project" {
				t.Fatalf("unexpected discovery: %+v", got)
			}
			// A fresh service consumes the persisted result without querying gh.
			installFakeGh(t, "#!/bin/sh\nexit 1\n")
			assertProjectDefault(t, NewRepositorySettingsService().GetProjectDefaultBranch(repo), branch, ProjectDefaultAutomatic)
		})
	}
}

func TestProjectDefaultBranchManualRefreshAndRestore(t *testing.T) {
	repo := defaultBranchTestRepo(t, "trunk", "release/2026")
	runGitCmd(t, repo, "remote", "add", "origin", "https://github.com/factory/project.git")
	service := NewRepositorySettingsService()
	if saved := service.WriteRepoPersonalConfig(repo, RepoPersonalConfig{LocalOnlyMode: true}); !saved.Success {
		t.Fatal(saved.Error)
	}
	fakeProjectDefault(t, "factory/project", "trunk")
	assertProjectDefault(t, service.RefreshProjectDefaultBranch(repo), "trunk", ProjectDefaultAutomatic)
	if chosen := service.SetProjectDefaultBranch(repo, "release/2026"); !chosen.Success {
		t.Fatal(chosen.Error)
	}
	service = NewRepositorySettingsService()
	assertProjectDefault(t, service.RefreshProjectDefaultBranch(repo), "release/2026", ProjectDefaultManual)
	if !service.ReadRepoPersonalConfig(repo).LocalOnlyMode {
		t.Fatal("unrelated personal setting was lost")
	}
	if restored := service.UseGitHubDefault(repo); !restored.Success {
		t.Fatal(restored.Error)
	}
	assertProjectDefault(t, service.GetProjectDefaultBranch(repo), "trunk", ProjectDefaultAutomatic)
	fakeProjectDefault(t, "factory/project", "release/2026")
	assertProjectDefault(t, service.RefreshProjectDefaultBranch(repo), "release/2026", ProjectDefaultAutomatic)
}

func TestProjectDefaultBranchOfflineAndMissingMetadata(t *testing.T) {
	for _, failure := range []struct{ name, script string }{
		{"missing_cli", "#!/bin/sh\nexit 127\n"},
		{"signed_out", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho 'not logged in' >&2\nexit 1\n"},
		{"offline", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho 'no such host' >&2\nexit 1\n"},
		{"null_default", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho '{\"nameWithOwner\":\"factory/project\",\"defaultBranchRef\":null}'\n"},
		{"malformed_metadata", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho '{'\n"},
	} {
		t.Run(failure.name, func(t *testing.T) {
			repo := defaultBranchTestRepo(t)
			runGitCmd(t, repo, "remote", "add", "origin", "https://github.com/factory/project.git")
			// A remote-tracking ref alone is sufficient; origin/HEAD is unnecessary.
			runGitCmd(t, repo, "update-ref", "refs/remotes/origin/release/2026", "HEAD")
			service := NewRepositorySettingsService()
			installFakeGh(t, failure.script)
			assertProjectDefault(t, service.RefreshProjectDefaultBranch(repo), "", ProjectDefaultAutomatic)
			fakeProjectDefault(t, "factory/project", "release/2026")
			assertProjectDefault(t, service.RefreshProjectDefaultBranch(repo), "release/2026", ProjectDefaultAutomatic)
			installFakeGh(t, failure.script)
			got := NewRepositorySettingsService().RefreshProjectDefaultBranch(repo)
			assertProjectDefault(t, got, "release/2026", ProjectDefaultAutomatic)
			if got.LookupMessage == "" || got.LookupStatus == "github" {
				t.Fatalf("missing independent lookup diagnostic: %+v", got)
			}
			runGitCmd(t, repo, "update-ref", "-d", "refs/remotes/origin/release/2026")
			assertProjectDefault(t, service.GetProjectDefaultBranch(repo), "", ProjectDefaultAutomatic)
		})
	}
}

func TestProjectDefaultBranchOriginChangeAndProjectIsolation(t *testing.T) {
	repo := defaultBranchTestRepo(t, "trunk", "release/2026")
	runGitCmd(t, repo, "remote", "add", "origin", "https://github.com/factory/first.git")
	service := NewRepositorySettingsService()
	fakeProjectDefault(t, "factory/first", "trunk")
	assertProjectDefault(t, service.RefreshProjectDefaultBranch(repo), "trunk", ProjectDefaultAutomatic)
	other := defaultBranchTestRepo(t, "trunk")
	runGitCmd(t, other, "remote", "add", "origin", "https://github.com/factory/first.git")
	assertProjectDefault(t, service.GetProjectDefaultBranch(other), "", ProjectDefaultAutomatic)
	runGitCmd(t, repo, "remote", "set-url", "origin", "https://github.com/factory/second.git")
	installFakeGh(t, "#!/bin/sh\nexit 1\n")
	assertProjectDefault(t, service.RefreshProjectDefaultBranch(repo), "", ProjectDefaultAutomatic)
	fakeProjectDefault(t, "factory/second", "release/2026")
	assertProjectDefault(t, service.RefreshProjectDefaultBranch(repo), "release/2026", ProjectDefaultAutomatic)
	if chosen := service.SetProjectDefaultBranch(repo, "trunk"); !chosen.Success {
		t.Fatal(chosen.Error)
	}
	runGitCmd(t, repo, "remote", "set-url", "origin", "https://github.com/factory/third.git")
	assertProjectDefault(t, service.GetProjectDefaultBranch(repo), "trunk", ProjectDefaultManual)
	runGitCmd(t, repo, "branch", "-D", "trunk")
	assertProjectDefault(t, service.GetProjectDefaultBranch(repo), "", ProjectDefaultManual)
}

func TestProjectDefaultBranchOriginChangesDuringDiscovery(t *testing.T) {
	repo := defaultBranchTestRepo(t, "trunk")
	runGitCmd(t, repo, "remote", "add", "origin", "https://github.com/factory/first.git")
	installFakeGh(t, `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
git remote set-url origin https://github.com/factory/second.git
echo '{"nameWithOwner":"factory/first","defaultBranchRef":{"name":"trunk"}}'
`)
	got := NewRepositorySettingsService().RefreshProjectDefaultBranch(repo)
	assertProjectDefault(t, got, "", ProjectDefaultAutomatic)
	if got.OriginRepository != "factory/second" {
		t.Fatalf("returned the previous origin after discovery: %+v", got)
	}
}

func TestProjectDefaultBranchRevalidatesAfterFailedDiscovery(t *testing.T) {
	failures := []struct {
		name   string
		script string
		status string
	}{
		{"command_failure", "echo 'network is unreachable' >&2\nexit 1\n", "unavailable"},
		{"null_default", "echo '{\"nameWithOwner\":\"factory/first\",\"defaultBranchRef\":null}'\n", "no-default"},
		{"malformed_metadata", "echo '{'\n", "no-default"},
	}
	mutations := []struct {
		name       string
		args       []string
		remoteOnly bool
		origin     string
	}{
		{"origin_changed", []string{"remote", "set-url", "origin", "https://github.com/factory/second.git"}, false, "factory/second"},
		{"local_branch_deleted", []string{"branch", "-D", "trunk"}, false, "factory/first"},
		{"tracking_ref_deleted", []string{"update-ref", "-d", "refs/remotes/origin/trunk"}, true, "factory/first"},
	}
	for _, failure := range failures {
		for _, mutation := range mutations {
			t.Run(failure.name+"/"+mutation.name, func(t *testing.T) {
				repo := defaultBranchTestRepo(t)
				if mutation.remoteOnly {
					runGitCmd(t, repo, "update-ref", "refs/remotes/origin/trunk", "HEAD")
				} else {
					runGitCmd(t, repo, "branch", "trunk")
				}
				runGitCmd(t, repo, "remote", "add", "origin", "https://github.com/factory/first.git")
				service := NewRepositorySettingsService()
				fakeProjectDefault(t, "factory/first", "trunk")
				assertProjectDefault(t, service.RefreshProjectDefaultBranch(repo), "trunk", ProjectDefaultAutomatic)
				before := service.ReadRepoPersonalConfig(repo)

				var command strings.Builder
				command.WriteString("git")
				for _, arg := range mutation.args {
					fmt.Fprintf(&command, " %q", arg)
				}
				installFakeGh(t, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\n"+command.String()+"\n"+failure.script)
				got := service.RefreshProjectDefaultBranch(repo)
				assertProjectDefault(t, got, "", ProjectDefaultAutomatic)
				if got.OriginRepository != mutation.origin || got.LookupStatus != failure.status || got.LookupMessage == "" {
					t.Fatalf("unexpected refreshed identity or diagnostic: %+v", got)
				}
				if after := service.ReadRepoPersonalConfig(repo); after != before {
					t.Fatalf("failed discovery changed stored preferences: got %+v, want %+v", after, before)
				}
			})
		}
	}
}

func TestProjectDefaultBranchRevalidatesManualSelectionAfterFailedDiscovery(t *testing.T) {
	repo := defaultBranchTestRepo(t, "trunk")
	runGitCmd(t, repo, "remote", "add", "origin", "https://github.com/factory/project.git")
	service := NewRepositorySettingsService()
	if selected := service.SetProjectDefaultBranch(repo, "trunk"); !selected.Success {
		t.Fatal(selected.Error)
	}
	installFakeGh(t, `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
git branch -D trunk
echo 'network is unreachable' >&2
exit 1
`)
	got := service.RefreshProjectDefaultBranch(repo)
	assertProjectDefault(t, got, "", ProjectDefaultManual)
	if got.LookupStatus != "unavailable" || service.ReadRepoPersonalConfig(repo).DefaultBranch.ManualBranch != "trunk" {
		t.Fatalf("failed discovery lost the manual preference or diagnostic: %+v", got)
	}
}

func TestProjectDefaultBranchFailedCacheWriteKeepsStoredAutomaticResult(t *testing.T) {
	repo := defaultBranchTestRepo(t, "trunk", "release/2026")
	runGitCmd(t, repo, "remote", "add", "origin", "https://github.com/factory/project.git")
	service := NewRepositorySettingsService()
	fakeProjectDefault(t, "factory/project", "trunk")
	assertProjectDefault(t, service.RefreshProjectDefaultBranch(repo), "trunk", ProjectDefaultAutomatic)
	before := service.ReadRepoPersonalConfig(repo)
	ignore := filepath.Join(repo, ".gitignore")
	if err := os.Remove(ignore); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(ignore, 0755); err != nil {
		t.Fatal(err)
	}
	fakeProjectDefault(t, "factory/project", "release/2026")
	got := service.RefreshProjectDefaultBranch(repo)
	assertProjectDefault(t, got, "trunk", ProjectDefaultAutomatic)
	if got.LookupStatus != "settings-error" || service.ReadRepoPersonalConfig(repo) != before {
		t.Fatalf("failed cache write changed the effective preference: %+v", got)
	}
}

func TestPersonalConfigAtomicWriteDoesNotStagePersonalFiles(t *testing.T) {
	for _, failReplace := range []bool{false, true} {
		t.Run(fmt.Sprintf("replace_failure=%t", failReplace), func(t *testing.T) {
			repo := defaultBranchTestRepo(t, "trunk")
			// Reproduce an existing project from before temporary files were protected.
			if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte(".iofabrik/local.json\n"), 0644); err != nil {
				t.Fatal(err)
			}
			service := NewRepositorySettingsService()
			old := RepoPersonalConfig{LocalOnlyMode: true}
			if saved := service.WriteRepoPersonalConfig(repo, old); !saved.Success {
				t.Fatal(saved.Error)
			}
			if err := os.WriteFile(filepath.Join(repo, "work.txt"), []byte("save this project file"), 0644); err != nil {
				t.Fatal(err)
			}
			updated := old
			updated.DefaultBranch.ManualBranch = "trunk"
			payload, err := json.Marshal(updated)
			if err != nil {
				t.Fatal(err)
			}
			replaceErr := errors.New("replacement failed")
			replaced := false
			err = writePersonalConfigAtomic(iofabrikDirPath(repo), filepath.Join(iofabrikDirPath(repo), personalConfigFile), payload, func(source, destination string) error {
				replaced = true
				if _, err := os.Stat(source); err != nil {
					t.Fatalf("temporary file unavailable during Save: %v", err)
				}
				if staged := NewGitService().AddAll(repo); !staged.Success {
					t.Fatal(staged.Error)
				}
				for _, path := range strings.Split(runGitOutput(t, repo, "diff", "--cached", "--name-only", "-z"), "\x00") {
					if strings.HasPrefix(path, ".iofabrik/") {
						t.Errorf("Save staged personal settings: %q", path)
					}
				}
				if tracked := strings.TrimSpace(runGitOutput(t, repo, "ls-files", "--", "work.txt")); tracked != "work.txt" {
					t.Fatal("Save did not stage the ordinary project file")
				}
				if failReplace {
					return replaceErr
				}
				return replaceFileAtomic(source, destination)
			})
			if !replaced {
				t.Fatal("atomic replacement was not exercised")
			}
			want := updated
			if failReplace {
				want = old
				if !errors.Is(err, replaceErr) {
					t.Fatalf("unexpected replacement failure: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if got := service.ReadRepoPersonalConfig(repo); got != want {
				t.Fatalf("unexpected stored personal settings: got %+v, want %+v", got, want)
			}
			files, err := os.ReadDir(iofabrikDirPath(repo))
			if err != nil {
				t.Fatal(err)
			}
			for _, file := range files {
				if file.Name() != personalConfigFile {
					t.Errorf("temporary personal file was not removed: %s", file.Name())
				}
			}
		})
	}
}

func TestProjectDefaultBranchRestoresStoredAutomaticOffline(t *testing.T) {
	repo := defaultBranchTestRepo(t, "trunk", "work")
	runGitCmd(t, repo, "remote", "add", "origin", "https://github.com/factory/project.git")
	service := NewRepositorySettingsService()
	fakeProjectDefault(t, "factory/project", "trunk")
	service.RefreshProjectDefaultBranch(repo)
	if chosen := service.SetProjectDefaultBranch(repo, "work"); !chosen.Success {
		t.Fatal(chosen.Error)
	}
	installFakeGh(t, "#!/bin/sh\nexit 1\n")
	if restored := service.UseGitHubDefault(repo); !restored.Success {
		t.Fatal(restored.Error)
	}
	assertProjectDefault(t, service.GetProjectDefaultBranch(repo), "trunk", ProjectDefaultAutomatic)
	if got := strings.TrimSpace(runGitOutput(t, repo, "branch", "--show-current")); got != "main" {
		t.Fatalf("changing preference switched the checkout: %s", got)
	}
}

func TestProjectDefaultBranchLocalInitializationAndImports(t *testing.T) {
	service := NewRepositorySettingsService()
	newRepo := t.TempDir()
	if initialized := NewGitService().InitRepo(newRepo); !initialized.Success {
		t.Fatal(initialized.Error)
	}
	assertProjectDefault(t, service.GetProjectDefaultBranch(newRepo), "main", ProjectDefaultAutomatic)
	if !service.runner.RunGit(newRepo, "symbolic-ref", "HEAD").Success {
		t.Fatal("initialization lost unborn HEAD")
	}
	imported := defaultBranchTestRepo(t, "trunk")
	assertProjectDefault(t, service.RefreshProjectDefaultBranch(imported), "", ProjectDefaultAutomatic)
	if chosen := service.SetProjectDefaultBranch(imported, "trunk"); !chosen.Success {
		t.Fatal(chosen.Error)
	}
	assertProjectDefault(t, service.GetProjectDefaultBranch(imported), "trunk", ProjectDefaultManual)
	unborn := t.TempDir()
	runGitCmd(t, unborn, "init", "-b", "new-work")
	assertProjectDefault(t, service.GetProjectDefaultBranch(unborn), "", ProjectDefaultAutomatic)
	if selected := service.SetProjectDefaultBranch(unborn, "new-work"); !selected.Success {
		t.Fatal(selected.Error)
	}
	assertProjectDefault(t, service.GetProjectDefaultBranch(unborn), "new-work", ProjectDefaultManual)
	// Non-GitHub origin never falls back to a conventional branch.
	runGitCmd(t, newRepo, "remote", "add", "origin", "https://example.com/factory/project.git")
	assertProjectDefault(t, service.GetProjectDefaultBranch(newRepo), "", ProjectDefaultAutomatic)
}

func TestProjectDefaultBranchFailureRetainsPreference(t *testing.T) {
	repo := defaultBranchTestRepo(t, "Release/2026", "trunk")
	runGitCmd(t, repo, "remote", "add", "origin", "https://github.com/factory/project.git")
	service := NewRepositorySettingsService()
	if selected := service.SetProjectDefaultBranch(repo, "Release/2026"); !selected.Success {
		t.Fatal(selected.Error)
	}
	if selected := service.SetProjectDefaultBranch(repo, "release/2026"); selected.Success {
		t.Fatal("selection ignored exact branch case")
	}
	installFakeGh(t, "#!/bin/sh\nexit 1\n")
	if restored := service.UseGitHubDefault(repo); restored.Success {
		t.Fatal("restored an unusable automatic result")
	}
	assertProjectDefault(t, service.GetProjectDefaultBranch(repo), "Release/2026", ProjectDefaultManual)
	configPath := filepath.Join(iofabrikDirPath(repo), personalConfigFile)
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	// Force a persistence failure after an existing selection without changing
	// the config itself. The previous bytes must survive the failed write.
	ignore := filepath.Join(repo, ".gitignore")
	if err := os.Remove(ignore); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(ignore, 0755); err != nil {
		t.Fatal(err)
	}
	if saved := service.SetProjectDefaultBranch(repo, "trunk"); saved.Success || strings.Contains(saved.Error, repo) {
		t.Fatalf("unexpected failed save: %+v", saved)
	}
	after, err := os.ReadFile(configPath)
	if err != nil || string(after) != string(before) {
		t.Fatalf("failed save replaced preference: %v", err)
	}
	fakeProjectDefault(t, "factory/project", "trunk")
	if restored := service.UseGitHubDefault(repo); restored.Success {
		t.Fatal("restore succeeded despite persistence failure")
	}
	assertProjectDefault(t, service.GetProjectDefaultBranch(repo), "Release/2026", ProjectDefaultManual)
}

func TestProjectDefaultBranchUnreadableConfigIsNotOverwritten(t *testing.T) {
	repo := defaultBranchTestRepo(t)
	service := NewRepositorySettingsService()
	writeMigrationFixture(t, filepath.Join(iofabrikDirPath(repo), personalConfigFile), "{")
	got := service.RefreshProjectDefaultBranch(repo)
	if got.LookupStatus != "settings-error" || got.Availability != ProjectDefaultNeedsSelection {
		t.Fatalf("unreadable config did not require recovery: %+v", got)
	}
	if saved := service.SetProjectDefaultBranch(repo, "main"); saved.Success {
		t.Fatal("overwrote unreadable settings")
	}
}
