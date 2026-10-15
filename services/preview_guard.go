package services

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const previewBusyMessage = "A preview is being generated for this project. Wait for it to finish, then try again."
const previewRecoveryMessage = "A preview was interrupted. Select Generate preview again to restore complete project files before saving."

func previewStateDirectory() string {
	return filepath.Join(GetDataLocationsSnapshot().LocalDataDir, "LDSDK")
}

func previewPathKey(path string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(normalizeRepositoryKey(path))))
}

func acquirePreviewLock(path string, exclusive bool) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	if err := previewPhysicalPath(filepath.Dir(path)); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = previewPhysicalPath(path); err == nil {
		err = lockPreviewFile(file, exclusive)
	}
	if err != nil {
		file.Close()
		return nil, err
	}
	return func() { _ = file.Close() }, nil
}

func previewPhysicalPath(path string) error {
	for part := filepath.Clean(path); ; part = filepath.Dir(part) {
		if _, err := previewFileIdentity(part); err != nil {
			return err
		}
		if filepath.Dir(part) == part {
			return nil
		}
	}
}

func previewRoot(runner gitAdminPathRunner, repo string) (string, error) {
	result := runner.RunGit(repo, "rev-parse", "--path-format=absolute", "--show-toplevel")
	if !result.Success {
		return "", fmt.Errorf("cannot resolve project")
	}
	return filepath.Clean(strings.TrimSpace(result.Stdout)), nil
}

// Shared mutation leases span composite app operations; command-level leases
// also protect background Git work. The exclusive generation lease is held
// through conversion, publication and recovery, across app processes.
func previewMutationLease(repo string) (func(), error) {
	if repo == "" {
		return func() {}, nil
	}
	if info, err := os.Stat(repo); err == nil && !info.IsDir() {
		repo = filepath.Dir(repo)
	}
	runner := NewCommandRunner()
	runner.previewOwner = true // identity queries must not recurse through this guard
	root, err := previewRoot(runner, repo)
	if err != nil {
		return func() {}, nil
	} // initialization/non-repository operations
	identity, err := gitCommonDirPath(runner, root)
	if err != nil {
		return nil, fmt.Errorf("Cannot check whether a preview is running. Reopen the project and try again.")
	}
	release, err := acquirePreviewLock(filepath.Join(previewStateDirectory(), "repo-locks", previewPathKey(identity)+".lock"), false)
	if err != nil {
		return nil, fmt.Errorf("%s", previewBusyMessage)
	}
	journal := filepath.Join(previewStateDirectory(), "transactions", previewPathKey(root)+".json")
	if _, err := os.Lstat(journal); !os.IsNotExist(err) {
		release()
		return nil, fmt.Errorf("%s", previewRecoveryMessage)
	}
	return release, nil
}

func (r *CommandRunner) previewCommandLease(workDir, name string, args []string) (func(), error) {
	if r.previewOwner || workDir == "" || (name != GitPath() && name != "git") {
		return func() {}, nil
	}
	command := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "-c" || arg == "-C" || arg == "--git-dir" || arg == "--work-tree" {
			i++
			continue
		}
		if strings.HasPrefix(arg, "-") {
			continue
		}
		command = arg
		break
	}
	switch command {
	case "rev-parse", "status", "diff", "log", "show", "ls-files", "ls-tree", "cat-file", "check-attr", "check-ignore", "merge-base", "rev-list", "for-each-ref", "version", "ls-remote", "check-ref-format":
		return func() {}, nil
	case "symbolic-ref":
		// Only the existing query forms are read-only; setting/deleting a
		// symbolic reference must hold a mutation lease too.
		if len(args) == 3 && (args[1] == "-q" || args[1] == "--short") && args[2] == "HEAD" {
			return func() {}, nil
		}
	}
	return previewMutationLease(workDir)
}
