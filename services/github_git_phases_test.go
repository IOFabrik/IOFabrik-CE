package services

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Only the GitHub API response is faked; local setup, clone and push use real
// Git and disposable repositories. No real GitHub repository is created.
func TestGitHubCreateGitPhases(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture gh script requires Python on Unix")
	}
	root := t.TempDir()
	global := filepath.Join(root, "config")
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_COUNT", "0")
	t.Setenv("GIT_CONFIG_PARAMETERS", "")
	t.Setenv("IOFABRIK_CREATE_LOG", filepath.Join(root, "gh-calls"))
	installFakeGh(t, `#!/usr/bin/python3
import os, sys, subprocess
args = sys.argv[1:]
with open(os.environ['IOFABRIK_CREATE_LOG'], 'a') as f: f.write(' '.join(args) + '\n')
if args[:2] == ['auth', 'status']: sys.exit(int(os.environ.get('IOFABRIK_AUTH_EXIT', '0')))
if args[:2] == ['config', 'get']: print(os.environ.get('IOFABRIK_PROTOCOL', 'https')); sys.exit(0)
if args[:2] != ['repo', 'create'] or '--push' in args or '--clone' in args: sys.exit(2)
if os.environ.get('IOFABRIK_API_FAIL'): sys.exit(1)
if '--source' in args:
    subprocess.check_call(['git', 'remote', 'add', 'origin', os.environ['IOFABRIK_PUBLISH_DEST']])
print(os.environ.get('IOFABRIK_CREATED_URL', 'https://github.com/fixture/new-repo'))
`)
	runner := NewCommandRunner()
	dest := filepath.Join(root, "remote.git")
	for _, args := range [][]string{{"init", "--bare", dest}, {"config", "--global", "user.name", "Fixture"}, {"config", "--global", "user.email", "fixture@example.invalid"}, {"config", "--global", "init.defaultBranch", "fixture-main"}, {"config", "--global", "url." + dest + ".insteadOf", "https://github.com/fixture/new-repo.git"}, {"config", "--global", "--add", "url." + dest + ".insteadOf", "git@github.com:fixture/new-repo.git"}} {
		if result := runner.RunGit(root, args...); !result.Success {
			t.Fatal(result.Error)
		}
	}
	configBefore, _ := os.ReadFile(global)
	service := NewGitHubService()
	t.Run("no commits stops before API", func(t *testing.T) {
		local := filepath.Join(root, "empty-source")
		runner.RunGit(root, "init", local)
		got := service.RepoCreateFromLocal(local, "fixture", "", true, "")
		if got.Success {
			t.Fatal("empty repository was published")
		}
		if data, _ := os.ReadFile(os.Getenv("IOFABRIK_CREATE_LOG")); len(data) > 0 {
			t.Fatal("empty repository reached gh before preflight failed")
		}
	})
	runner.RunGit(dest, "symbolic-ref", "HEAD", "refs/heads/fixture-main")
	source := filepath.Join(root, "source")
	runner.RunGit(root, "init", source)
	if got := runner.RunGit(source, "commit", "--allow-empty", "-m", "fixture"); !got.Success {
		t.Fatal(got.Error)
	}
	t.Setenv("IOFABRIK_PUBLISH_DEST", dest)
	t.Run("publish sets upstream", func(t *testing.T) {
		got := service.RepoCreateFromLocal(source, "fixture", "description", true, "owner")
		if !got.Success || got.Repo.FullName != "owner/fixture" {
			t.Fatal("publish failed or changed result fields")
		}
		upstream := runner.RunGit(source, "rev-parse", "--abbrev-ref", "@{upstream}")
		if !upstream.Success || strings.TrimSpace(upstream.Stdout) != "origin/fixture-main" {
			t.Fatal("push did not set the original upstream")
		}
	})
	t.Run("bare publish mirrors refs", func(t *testing.T) {
		bare := filepath.Join(root, "source.git")
		runner.RunGit(root, "clone", "--bare", source, bare)
		runner.RunGit(bare, "remote", "remove", "origin")
		runner.RunGit(bare, "tag", "fixture-tag")
		if got := service.RepoCreateFromLocal(bare, "fixture", "", false, ""); !got.Success {
			t.Fatal("bare publish failed")
		}
		if got := runner.RunGit(dest, "show-ref", "--verify", "refs/tags/fixture-tag"); !got.Success {
			t.Fatal("bare push did not mirror tags")
		}
	})
	for _, protocol := range []string{"https", "ssh"} {
		t.Run(protocol+" empty create", func(t *testing.T) {
			t.Setenv("IOFABRIK_PROTOCOL", protocol)
			parent := t.TempDir()
			got := service.RepoCreate(GitHubRepoCreateOptions{Name: "owner/new-repo", Clone: true, ClonePath: parent, Private: true})
			want := filepath.Join(parent, "new-repo")
			if !got.Success || got.CloneDir != want {
				t.Fatal("empty create did not use the canonical destination")
			}
			expected := "https://github.com/fixture/new-repo.git"
			if protocol == "ssh" {
				expected = "git@github.com:fixture/new-repo.git"
			}
			// get-url expands insteadOf; inspect the actual stored URL instead.
			remote := runner.RunGit(want, "config", "--get", "remote.origin.url")
			if !remote.Success || strings.TrimSpace(remote.Stdout) != expected {
				t.Fatal("create changed the chosen protocol")
			}
			if branch := runner.RunGit(want, "symbolic-ref", "--short", "HEAD"); strings.TrimSpace(branch.Stdout) != "fixture-main" {
				t.Fatal("empty init ignored Git's default branch")
			}
		})
		t.Run(protocol+" initialized create", func(t *testing.T) {
			t.Setenv("IOFABRIK_PROTOCOL", protocol)
			parent := t.TempDir()
			got := service.RepoCreate(GitHubRepoCreateOptions{Name: "new-repo", Clone: true, ClonePath: parent, AddReadme: true})
			if !got.Success || !runner.RunGit(got.CloneDir, "rev-parse", "HEAD").Success {
				t.Fatal("initialized create was not cloned")
			}
		})
	}
	t.Run("enterprise empty create", func(t *testing.T) {
		t.Setenv("IOFABRIK_CREATED_URL", "https://ghe.example/fixture/new-repo")
		parent := t.TempDir()
		got := service.RepoCreate(GitHubRepoCreateOptions{Name: "new-repo", Clone: true, ClonePath: parent})
		if !got.Success || got.CloneDir != filepath.Join(parent, "new-repo") {
			t.Fatal("enterprise create lost its local destination")
		}
		remote := runner.RunGit(got.CloneDir, "config", "--get", "remote.origin.url")
		if strings.TrimSpace(remote.Stdout) != "https://ghe.example/fixture/new-repo.git" {
			t.Fatal("enterprise create changed the remote")
		}
	})
	t.Run("failed push reports failure", func(t *testing.T) {
		local := filepath.Join(root, "push-failure")
		runner.RunGit(root, "clone", source, local)
		runner.RunGit(local, "remote", "remove", "origin")
		t.Setenv("IOFABRIK_PUBLISH_DEST", filepath.Join(root, "missing.git"))
		if got := service.RepoCreateFromLocal(local, "fixture", "", false, ""); got.Success || got.Error == "" {
			t.Fatal("failed push was reported as success")
		}
	})
	t.Run("failed API does not clone", func(t *testing.T) {
		t.Setenv("IOFABRIK_API_FAIL", "1")
		parent := t.TempDir()
		if got := service.RepoCreate(GitHubRepoCreateOptions{Name: "fixture", Clone: true, ClonePath: parent}); got.Success {
			t.Fatal("failed creation reported success")
		}
		if entries, _ := os.ReadDir(parent); len(entries) != 0 {
			t.Fatal("local setup ran after API failure")
		}
	})
	after, _ := os.ReadFile(global)
	if string(after) != string(configBefore) {
		t.Fatal("create/publish changed global credential configuration")
	}
}

func TestGitCredentialProfileCapture(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture gh script requires Unix shell")
	}
	root := t.TempDir()
	calls := filepath.Join(root, "calls")
	t.Setenv("IOFABRIK_AUTH_CALLS", calls)
	installFakeGh(t, "#!/bin/sh\nprintf 'status\\n' >> \"$IOFABRIK_AUTH_CALLS\"\nexit 0\n")
	runner := NewCommandRunner()
	operation := runner.forGitOperation()
	if !operation.credentials.usable || runner.credentials != nil || operation.forGitOperation() != operation {
		t.Fatal("profile was not captured and reused independently")
	}
	runner.RunGit(root, "version")
	NewGitService().DeleteBranch(root, "", true)
	data, _ := os.ReadFile(calls)
	if string(data) != "status\n" {
		t.Fatal("local-only command or reused profile checked authentication again")
	}
	installFakeGh(t, "#!/bin/sh\nexit 1\n")
	if runner.forGitOperation().credentials.usable {
		t.Fatal("unusable gh enabled override")
	}
	if !runner.forGitOperation(true).credentials.usable {
		t.Fatal("existing authentication decision was not reused")
	}
}
