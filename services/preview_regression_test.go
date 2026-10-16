package services

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"iofabrik/internal/ldsdkprotocol"
)

func TestPreviewLinkedCacheAllowsOrdinaryMutations(t *testing.T) {
	s, root, _ := previewTestService(t)
	cache := t.TempDir()
	link := filepath.Join(t.TempDir(), "cache")
	if err := os.Symlink(cache, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	previewStateDirectory = func() string { return filepath.Join(link, "IOFabrik", "LDSDK") }
	if result := NewGitService().CommitAll(root, "Save with linked cache"); !result.Success {
		t.Fatalf("ordinary save blocked: %+v", result)
	}
	if result := NewGitService().CheckoutNewBranch(root, "linked-cache"); !result.Success {
		t.Fatalf("ordinary checkout blocked: %+v", result)
	}
	common, err := gitCommonDirPath(s.runner, root)
	if err != nil {
		t.Fatal(err)
	}
	release, err := acquirePreviewLock(filepath.Join(cache, "IOFabrik", "LDSDK", "repo-locks", previewPathKey(common)+".lock"), true)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if result := NewCommandRunner().RunGit(root, "add", "."); result.Success {
		t.Fatal("linked and physical cache paths did not share the same lock")
	}
}

func TestPreviewPublicationWithReadOnlyProjectParent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires POSIX directory permissions")
	}
	s, originalRoot, _ := previewTestService(t)
	parent := t.TempDir()
	root := filepath.Join(parent, "project")
	if err := os.Rename(originalRoot, root); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0700) })
	if err := os.Mkdir(filepath.Join(parent, "probe"), 0700); err == nil {
		t.Skip("directory permissions not enforced")
	}
	requirePreviewSuccess(t, generateTestPreview(t, s, root, filepath.Join(root, "Controller.ACD")))
}

func TestPreviewReadQueriesDuringGeneration(t *testing.T) {
	s, root, source := previewTestService(t)
	runGitCmd(t, root, "add", ".")
	runGitCmd(t, root, "commit", "-m", "Initial project")
	runGitCmd(t, root, "branch", "-M", "main")
	runGitCmd(t, root, "remote", "add", "origin", root)
	runGitCmd(t, root, "update-ref", "refs/remotes/origin/main", "HEAD")
	runGitCmd(t, root, "branch", "--set-upstream-to=origin/main", "main")
	settings := NewRepositorySettingsService()
	if result := settings.SetProjectDefaultBranch(root, "main"); !result.Success {
		t.Fatal(result)
	}
	s.runHelper = previewFakeHelper(t, func(_ ldsdkprotocol.Request) {
		g := NewGitService()
		if status := g.Status(root); status.HasError || !status.HasUpstream {
			t.Errorf("status lost upstream: %+v", status)
		}
		if branches := g.Branches(root); branches.HasError || len(branches.Local) == 0 {
			t.Errorf("branches unavailable: %+v", branches)
		}
		if result := settings.GetProjectDefaultBranch(root); result.Availability == ProjectDefaultNeedsSelection {
			t.Errorf("default branch lost: %+v", result)
		}
		for _, args := range [][]string{
			{"remote"}, {"remote", "-v"}, {"remote", "get-url", "origin"},
			{"branch", "-vv"}, {"branch", "-r"}, {"branch", "-a", "--format=%(refname:short)|%(objectname)"},
			{"show-ref", "--verify", "--quiet", "refs/heads/main"},
			{"config", "--local", "--get", "remote.origin.url"}, {"config", "--local", "--list"}, {"config", "user.name"},
			{"stash", "list", "--pretty=format:%gd|%gs"}, {"clean", "-fdn"},
			{"reflog", "--format=%h|%gd|%gs|%ci", "-n", "20"},
			{"lfs", "ls-files", "--name-only"}, {"lfs", "status", "--porcelain"}, {"lfs", "env"},
			{"-c", "color.ui=false", "branch", "-vv"},
		} {
			if result := NewCommandRunner().RunGit(root, args...); !result.Success {
				t.Errorf("query %v blocked: %+v", args, result)
			}
		}
		for _, args := range [][]string{
			{"branch", "-D", "main"}, {"branch", "-m", "other"},
			{"remote", "remove", "origin"}, {"remote", "set-url", "origin", "other"},
			{"config", "--local", "user.name", "other"}, {"config", "--local", "--unset", "user.name"},
			{"symbolic-ref", "HEAD", "refs/heads/other"}, {"stash", "clear"},
			{"reflog", "expire", "--all"}, {"clean", "-fd"}, {"lfs", "prune"}, {"lfs", "track", "*.ACD"},
		} {
			release, err := NewCommandRunner().previewCommandLease(root, GitPath(), args)
			if err == nil {
				release()
				t.Errorf("mutation %v bypassed guard", args)
			}
		}
		for name, mutate := range map[string]func() OperationResult{
			"add":          func() OperationResult { return g.Add(root, "Controller.ACD") },
			"add all":      func() OperationResult { return g.AddAll(root) },
			"add files":    func() OperationResult { return g.AddFiles(root, []string{"Controller.ACD"}) },
			"unstage":      func() OperationResult { return g.Unstage(root, "Controller.ACD") },
			"unstage all":  func() OperationResult { return g.UnstageAll(root) },
			"restore":      func() OperationResult { return g.Restore(root, "Controller.ACD") },
			"restore all":  func() OperationResult { return g.RestoreAll(root) },
			"clean":        func() OperationResult { return g.Clean(root) },
			"commit":       func() OperationResult { return g.Commit(root, "blocked") },
			"checkout":     func() OperationResult { return g.Checkout(root, "main") },
			"new branch":   func() OperationResult { return g.CheckoutNewBranch(root, "blocked") },
			"reset hard":   func() OperationResult { return g.ResetHard(root, "HEAD") },
			"reset soft":   func() OperationResult { return g.ResetSoft(root, "HEAD") },
			"reset mixed":  func() OperationResult { return g.ResetMixed(root, "HEAD") },
			"set config":   func() OperationResult { return settings.SetGitConfig(root, "user.name", "other") },
			"unset config": func() OperationResult { return settings.UnsetGitConfig(root, "user.name") },
		} {
			if result := mutate(); result.Success || !strings.Contains(result.Error, previewBusyMessage) {
				t.Errorf("%s bypassed command guard: %+v", name, result)
			}
		}
	})
	requirePreviewSuccess(t, generateTestPreview(t, s, root, source))
}

func TestPreviewPublicationRetainsJournalUntilStageRemoved(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires POSIX directory permissions")
	}
	s, root, source := previewTestService(t)
	id := newPreviewOperationID()
	stage := previewStagePath(filepath.Join(root, "Controller.preview"), id)
	s.publicationFault = func(phase string) error {
		if phase == "installed" {
			if err := os.Chmod(stage, 0500); err != nil {
				t.Fatal(err)
			}
		}
		return nil
	}
	t.Cleanup(func() { _ = os.Chmod(stage, 0700) })
	if result := s.GeneratePreview(root, source, id); result.Success {
		t.Error("cleanup failure reported success")
	}
	if _, err := os.Stat(previewJournalPath(s.stateDir, root)); err != nil {
		t.Error("journal discarded before staging cleanup", err)
	}
	if result := NewGitService().CommitAll(root, "must not save staging"); result.Success {
		t.Error("ordinary save included retained staging")
	}
	if err := os.Chmod(stage, 0700); err != nil {
		t.Fatal(err)
	}
	if err := recoverPreviewPublication(s.stateDir, root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatal("staging survived recovery")
	}
}

func TestPreviewRecoveryRemovesAbandonedWork(t *testing.T) {
	s, root, source := previewTestService(t)
	var abandoned string
	s.runHelper = func(_ context.Context, work string, _, _ io.Writer, _ string, _ ...string) CommandResult {
		abandoned = work
		if err := os.WriteFile(filepath.Join(work, "private.ACD"), []byte("private source copy"), 0600); err != nil {
			t.Fatal(err)
		}
		return CommandResult{Error: "interrupted"}
	}
	if generateTestPreview(t, s, root, source).Success {
		t.Fatal("interruption accepted")
	}
	if err := s.reconcileSDK("boot-one"); err == nil {
		t.Fatal("uncertain SDK state cleared")
	}
	if _, err := os.Stat(abandoned); err != nil {
		t.Fatal("work removed before SDK recovery")
	}
	if err := s.reconcileSDK("boot-two"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(abandoned); !os.IsNotExist(err) {
		t.Fatal("private source copy retained after confirmed recovery")
	}
}

func TestPreviewCanStopBackgroundTasksDuringGeneration(t *testing.T) {
	s, root, source := previewTestService(t)
	settings := NewRepositorySettingsService()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	settings.taskContexts[root] = ctx
	settings.taskCancels[root] = cancel
	settings.activeRepo = root
	s.runHelper = previewFakeHelper(t, func(_ ldsdkprotocol.Request) {
		if result := settings.StopBackgroundTasks(root); !result.Success {
			t.Error(result)
		}
		if ctx.Err() == nil {
			t.Error("background tasks remain active after project close")
		}
	})
	requirePreviewSuccess(t, generateTestPreview(t, s, root, source))
}

func TestPreviewInterruptedStagingBlocksSaveUntilRecovery(t *testing.T) {
	s, root, source := previewTestService(t)
	id := newPreviewOperationID()
	stage := previewStagePath(filepath.Join(root, "Controller.preview"), id)
	s.publicationFault = func(phase string) error {
		if phase == "staged" {
			panic("process lost while preparing output")
		}
		return nil
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Error("crash not injected")
			}
		}()
		s.GeneratePreview(root, source, id)
	}()
	if _, err := os.Stat(previewJournalPath(s.stateDir, root)); err != nil {
		t.Fatal("staging was not journaled", err)
	}
	if result := NewGitService().CommitAll(root, "must not save staging"); result.Success {
		t.Fatal("staging could be saved")
	}
	if err := recoverPreviewPublication(s.stateDir, root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatal("staging survived recovery")
	}
}

func TestPreviewRecoveryAcceptsLegacyAndAlreadyCleanedStages(t *testing.T) {
	for _, layout := range []string{"legacy", "already-cleaned"} {
		t.Run(layout, func(t *testing.T) {
			s, root, source := previewTestService(t)
			id := newPreviewOperationID()
			destination := filepath.Join(root, "Controller.preview")
			s.publicationFault = func(phase string) error {
				if phase == "installed" {
					panic("process lost")
				}
				return nil
			}
			func() {
				defer func() {
					if recover() == nil {
						t.Error("crash not injected")
					}
				}()
				s.GeneratePreview(root, source, id)
			}()
			journal := previewJournalPath(s.stateDir, root)
			data, err := os.ReadFile(journal)
			if err != nil {
				t.Fatal(err)
			}
			var record previewTransaction
			if err := json.Unmarshal(data, &record); err != nil {
				t.Fatal(err)
			}
			stage := previewStagePath(destination, id)
			if layout == "legacy" {
				if err := os.Rename(stage, previewStagePath(root, id)); err != nil {
					t.Fatal(err)
				}
				record.StageInProject = false
			} else {
				record.Committed = true
				if err := os.RemoveAll(stage); err != nil {
					t.Fatal(err)
				}
			}
			if err := previewWriteJSON(journal, record); err != nil {
				t.Fatal(err)
			}
			if err := recoverPreviewPublication(s.stateDir, root); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(journal); !os.IsNotExist(err) {
				t.Fatal("journal survived recovery")
			}
		})
	}
}
