# Git Workflows

> Complete decision trees for all git operations in IOFabrik.

## Design Principles

1. **Merge-only** — No rebase. Ever. Too complex for non-technical users.
2. **Squash by default** — Produces linear, readable history.
3. **Auto-stage** — `git add .` before every commit. Users don't understand staging.
4. **Per-file conflict resolution** — Three simple options, no manual text editing.
5. **Recovery-first** — Always provide a way out of stuck states.

## Save Changes (Commit)

```
User clicks "Save Changes"
  │
  ├── Protected branch check
  │   ├── If protected + warn mode → Show warning banner, allow save
  │   └── If protected + block mode → Show MainBranchSaveChoiceModal
  │       ├── "Start New Task" → Create branch, then save
  │       └── "Save Here" → Proceed with save (if allowed)
  │
  ├── LFS auto-track check (useLfsAutoTrackBeforeSave)
  │   ├── DetectLargeFiles(threshold)
  │   ├── If large files found → Show LFSAutoTrackModal
  │   │   ├── User selects patterns → TrackPattern() for each
  │   │   └── Proceed
  │   └── If no large files → Proceed
  │
  ├── git add .
  ├── git commit -m "<message>"
  │
  ├── If success → toast "Changes saved" → Refresh status
  └── If failure → toast error with message
```

## Sync (Pull + Push)

```
User clicks "Sync"
  │
  ├── ProgressService.SyncWithProgress()
  │   ├── Show ProgressModal
  │   ├── git pull --no-rebase --progress
  │   │   ├── If conflicts → Set mergeState, show MergeRequestScreen
  │   │   ├── If up-to-date → Continue to push
  │   │   └── If error → Show error, abort
  │   │
  │   └── git push --progress
  │       ├── If success → toast "Synced" → ProgressModal dismisses
  │       ├── If rejected (remote ahead) → Retry pull first
  │       └── If error → Show error with recovery options
  │
  └── Refresh all state
```

## Push (Share)

```
User clicks "Share"
  │
  ├── Check if remote exists
  │   └── If no remote → Show PublishToCloudModal (create GitHub repo)
  │
  ├── Check if upstream set
  │   └── If no upstream → git push -u origin <branch>
  │
  ├── ProgressService.PushWithProgress()
  │   ├── git push --progress
  │   ├── Show ProgressModal
  │   └── Handle result
  │
  └── Refresh all state
```

## Branch Operations

### Create Branch (New Task)
```
User opens BranchModal → enters name
  │
  ├── Check for uncommitted changes
  │   ├── If changes exist → Ask "Move changes to new branch?"
  │   │   ├── Yes → git stash, create branch, git stash pop
  │   │   └── No → Commit first, then create branch
  │   └── No changes → Proceed
  │
  ├── git checkout -b <name>
  └── Refresh state
```

### Switch Branch
```
User selects branch in BranchModal
  │
  ├── Check for uncommitted changes
  │   ├── If changes → Prompt: "Save changes first?"
  │   │   ├── Stash → git stash, switch, attempt stash pop
  │   │   ├── Discard → git restore ., switch
  │   │   └── Cancel → Abort switch
  │   └── No changes → Proceed
  │
  ├── Check for LFS locks on current branch
  │   └── If locked files → Warn user
  │
  ├── git checkout <branch>
  └── Refresh state
```

## Merge

```
User selects source branch → clicks "Merge"
  │
  ├── Options:
  │   ├── isSquashMerge: true (default) → git merge --squash
  │   └── isSquashMerge: false → git merge
  │
  ├── git merge [--squash] <source>
  │   ├── Clean merge:
  │   │   ├── If squash → Auto-commit with merge message
  │   │   └── Done → Explorer shows ReadyToPushScreen
  │   │
  │   └── Conflicts:
  │       ├── Set mergeState in RepoContext
  │       ├── Show conflict files in MergeRequestScreen
  │       ├── Per-file resolution:
  │       │   ├── "Keep My Changes"    → git checkout --ours <file> && git add <file>
  │       │   ├── "Keep Their Changes" → git checkout --theirs <file> && git add <file>
  │       │   └── "Keep Both"          → Export both versions with _COPY_ suffix
  │       ├── When all resolved → git commit (complete merge)
  │       └── Or: "Cancel Merge" → git merge --abort
  │
  └── Refresh state
```

## Undo Operations

### Rewind (Undo Last Save)
```
User clicks "Rewind"
  → Show UndoLastSaveDialog (confirmation)
  → git reset --soft HEAD~1
  → Changes return to working tree (not lost)
  → Refresh status
```

### Discard All
```
User clicks "Discard All"
  → Show confirmation dialog (destructive!)
  → git restore .
  → git restore --staged .
  → All local changes permanently removed
  → Refresh status
```

## Stuck State Recovery

GitService detects stuck states by checking for marker files in `.git/`:

| State | Marker | Recovery |
|-------|--------|----------|
| Merge | `.git/MERGE_HEAD` | Abort or complete |
| Cherry-pick | `.git/CHERRY_PICK_HEAD` | Abort, continue, or skip |
| Revert | `.git/REVERT_HEAD` | Abort, continue, or skip |
| Rebase | `.git/rebase-merge/` or `.git/rebase-apply/` | Abort, continue, or skip |
| AM (patch) | `.git/rebase-apply/applying` | Abort or skip |
| Bisect | `.git/BISECT_LOG` | Reset (abort) |

The `RecoveryBanner` component shows when a stuck state is detected, with one-click recovery actions.

---

**Related:** [GitService](../backend/services/GitService.md) | [ProgressService](../backend/services/ProgressService.md) | [User-Facing Terminology](../../product/User-Facing%20Terminology.md)
