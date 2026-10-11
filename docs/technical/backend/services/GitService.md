# GitService

> `services/git_service.go` — ~5,185 lines, 115+ methods. The largest service in the app.

## Overview

GitService is the core of IOFabrik. It wraps every git CLI operation the app needs — from basic status checks to complex merge workflows, bisect, cherry-pick, and lock file management.

## Constructor

```go
func NewGitService() *GitService {
    return &GitService{
        runner: NewCommandRunner(),
    }
}
```

No event emission — all methods are synchronous request/response. For progress-streamed versions, see [ProgressService](ProgressService.md).

## Method Categories

### Repository Operations
| Method | Git Command | Returns |
|--------|------------|---------|
| `IsGitRepo(path)` | `git rev-parse --git-dir` | `bool` |
| `InitRepo(path)` | `git init` | `OperationResult` |
| `GetRepoRoot(path)` | `git rev-parse --show-toplevel` | `string` |
| `GetRemoteURL(repoPath)` | `git remote get-url origin` | `string` |
| `SetRemoteURL(repoPath, url)` | `git remote set-url origin <url>` | `OperationResult` |
| `AddRemote(repoPath, name, url)` | `git remote add <name> <url>` | `OperationResult` |

### Status & Changes
| Method | Git Command | Returns |
|--------|------------|---------|
| `GetStatus(repoPath)` | `git status --porcelain -uall` | `[]FileStatus` |
| `GetStatusSummary(repoPath)` | `git status --porcelain` | `StatusSummary` |
| `HasUncommittedChanges(repoPath)` | `git status --porcelain` | `bool` |
| `HasUntrackedFiles(repoPath)` | `git ls-files --others --exclude-standard` | `bool` |
| `GetStagedFiles(repoPath)` | `git diff --cached --name-status` | `[]FileStatus` |

### Commit Operations
| Method | Git Command | User Label |
|--------|------------|-----------|
| `CommitAll(repoPath, message)` | `git add . && git commit -m "..."` | "Save Changes" |
| `CommitStaged(repoPath, message)` | `git commit -m "..."` | — |
| `GetCommitLog(repoPath, limit)` | `git log --oneline -n <limit>` | — |
| `GetCommitDetails(repoPath, hash)` | `git show <hash>` | — |
| `GetCommitGraph(repoPath, limit)` | `git log --graph --all --oneline` | — |

### Branch Operations
| Method | Git Command | User Label |
|--------|------------|-----------|
| `GetCurrentBranch(repoPath)` | `git branch --show-current` | — |
| `GetBranches(repoPath)` | `git branch -a` | — |
| `CreateBranch(repoPath, name)` | `git checkout -b <name>` | "New Task" |
| `SwitchBranch(repoPath, name)` | `git checkout <name>` | "Switch Task" |
| `DeleteBranch(repoPath, name)` | `git branch -d <name>` | — |
| `RenameBranch(repoPath, old, new)` | `git branch -m <old> <new>` | — |
| `GetBranchTrackingInfo(repoPath)` | `git for-each-ref --format=...` | — |

### Sync Operations
| Method | Git Command | User Label |
|--------|------------|-----------|
| `Pull(repoPath)` | `git pull --no-rebase` | "Sync" (part 1) |
| `Push(repoPath)` | `git push` | "Share" |
| `PushWithSetUpstream(repoPath, branch)` | `git push -u origin <branch>` | "Share" (first time) |
| `Fetch(repoPath)` | `git fetch --all` | — |
| `Sync(repoPath)` | `git pull --no-rebase && git push` | "Sync" |

### Merge Operations
| Method | Git Command | User Label |
|--------|------------|-----------|
| `StartMergeWithOptions(repoPath, source, opts)` | `git merge [--squash] <source>` | "Merge" |
| `AbortMerge(repoPath)` | `git merge --abort` | "Cancel Merge" |
| `ContinueMerge(repoPath)` | `git merge --continue` | — |
| `GetMergeState(repoPath)` | Checks `.git/MERGE_HEAD` | — |
| `GetConflictFiles(repoPath)` | `git diff --name-only --diff-filter=U` | — |

### Conflict Resolution
| Method | Git Command | User Label |
|--------|------------|-----------|
| `ResolveConflictOurs(repoPath, file)` | `git checkout --ours <file>` | "Keep My Changes" |
| `ResolveConflictTheirs(repoPath, file)` | `git checkout --theirs <file>` | "Keep Their Changes" |
| `ResolveConflictBoth(repoPath, file)` | Custom: exports both versions | "Keep Both" |

### Stash Operations
| Method | Git Command | User Label |
|--------|------------|-----------|
| `StashSave(repoPath, message)` | `git stash push -m "..."` | "Save Work" |
| `StashPop(repoPath)` | `git stash pop` | "Restore Work" |
| `StashList(repoPath)` | `git stash list` | "Saved Work" |
| `StashDrop(repoPath, index)` | `git stash drop stash@{n}` | — |

### Undo / Reset
| Method | Git Command | User Label |
|--------|------------|-----------|
| `ResetSoftHead(repoPath)` | `git reset --soft HEAD~1` | "Rewind" |
| `DiscardAll(repoPath)` | `git restore . && git restore --staged .` | "Discard All" |
| `DiscardFile(repoPath, file)` | `git restore <file>` | "Discard" |

### Diff Operations
| Method | Git Command | Returns |
|--------|------------|---------|
| `GetDiff(repoPath)` | `git diff` | `string` (unified diff) |
| `GetStagedDiff(repoPath)` | `git diff --cached` | `string` |
| `GetFileDiff(repoPath, file)` | `git diff -- <file>` | `string` |
| `GetCommitDiff(repoPath, hash)` | `git diff <hash>^..<hash>` | `string` |
| `GetBranchDiff(repoPath, base, compare)` | `git diff <base>...<compare>` | `string` |

### Stuck State Recovery
| Method | Git Command | Purpose |
|--------|------------|---------|
| `GetStuckState(repoPath)` | Checks `.git/` markers | Detect merge/cherry-pick/revert/AM/bisect states |
| `AbortCherryPick(repoPath)` | `git cherry-pick --abort` | Recovery |
| `AbortRevert(repoPath)` | `git revert --abort` | Recovery |
| `AbortRebase(repoPath)` | `git rebase --abort` | Recovery |

## Key Types

```go
type FileStatus struct {
    Path      string `json:"path"`
    Status    string `json:"status"`    // "added", "modified", "deleted", "renamed", "untracked"
    Staged    bool   `json:"staged"`
    OldPath   string `json:"oldPath"`   // For renames
}

type CommitInfo struct {
    Hash        string `json:"hash"`
    ShortHash   string `json:"shortHash"`
    Message     string `json:"message"`
    Author      string `json:"author"`
    AuthorEmail string `json:"authorEmail"`
    Date        string `json:"date"`
    Refs        string `json:"refs"`
}

type BranchInfo struct {
    Name      string `json:"name"`
    IsCurrent bool   `json:"isCurrent"`
    IsRemote  bool   `json:"isRemote"`
    Upstream  string `json:"upstream"`
}

type StuckState struct {
    IsStuck    bool   `json:"isStuck"`
    State      string `json:"state"`      // "merge", "cherry-pick", "revert", "rebase", "am", "bisect"
    CanAbort   bool   `json:"canAbort"`
    CanContinue bool  `json:"canContinue"`
}
```

## Workflow Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Merge strategy | `--no-rebase` | Simpler for non-technical users |
| Default merge type | Squash (`--squash`) | Linear history is easier to understand |
| Staging | Auto-stage all (`git add .`) | Users don't understand staging |
| Conflict resolution | Per-file, 3 options | "Keep Mine", "Keep Theirs", "Keep Both" |
| Protected branches | Warn or require confirmation | Prevent accidental commits to main |

See [Git Workflows](../../guides/Git%20Workflows.md) for complete workflow decision trees.

---

**Related:** [ProgressService](ProgressService.md) (progress-wrapped versions) | [LFSService](LFSService.md) | [Git Workflows](../../guides/Git%20Workflows.md)
