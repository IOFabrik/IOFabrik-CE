# User-Facing Terminology

> **Golden rule:** If a non-technical user wouldn't understand the label, rewrite it.

IOFabrik maps Git operations to plain-English labels. Every engineer must use this terminology in all user-facing text — buttons, toasts, error messages, tooltips, and documentation shown to end users.

## Operation Labels

| User Label | Git Operation | Backend Method | Notes |
|------------|--------------|----------------|-------|
| **Save Changes** | `git add . && git commit -m "..."` | `GitService.CommitAll()` | Primary action for recording work |
| **Sync** | `git pull --no-rebase && git push` | `ProgressService.SyncWithProgress()` | Two-way sync with remote |
| **Share** / **Push** | `git push` | `ProgressService.PushWithProgress()` | One-way upload to remote |
| **Rewind** | `git reset --soft HEAD~1` | `GitService.ResetSoftHead()` | Undo last save, keep changes |
| **Discard All** | `git restore . && git restore --staged .` | `GitService.DiscardAll()` | Permanently remove local changes |
| **Merge** | `git merge --squash` | `GitService.StartMergeWithOptions()` | Squash merge by default |
| **New Task** / **New Branch** | `git checkout -b <name>` | `GitService.CreateBranch()` | Create a new line of work |
| **Switch Task** | `git checkout <branch>` | `GitService.SwitchBranch()` | Move to different line of work |
| **Saved Work** | `git stash` | `GitService.StashSave()` | Temporarily set aside changes |
| **Connect to GitHub** | `gh auth login` (device flow) | `GitHubService.AuthLoginStart()` | GitHub authentication |
| **Create Change Request** | `gh pr create` | `GitHubService.CreateChangeRequest()` | Submit a task for team review. See [Change Requests](Change%20Requests.md) |
## Concept Mapping

| Git Concept | IOFabrik Term | Where Used |
|-------------|-------------------|-----------|
| Repository | Project | Welcome screen, TopBar |
| Commit | Save / Saved change | Explorer, History |
| Branch | Task / Line of work | Branch modal, TopBar |
| Pull | Download / Sync | Sync button |
| Push | Share / Upload | Push button |
| Stage | (hidden) | Auto-staged on save |
| Merge conflict | Conflicting changes | Conflict resolution page |
| Stash | Saved Work | Branch modal |
| Remote | Cloud / GitHub | Settings, publish modal |
| Clone | Download Project | Welcome screen |
| HEAD | Latest save | Implicit |
| Pull request | Change Request | Reviews view, Explorer |

## Conflict Resolution Labels

| Action | Git Operation | What It Does (User Text) |
|--------|--------------|--------------------------|
| **Keep My Changes** | `git checkout --ours <file>` | Keep your version of the file |
| **Keep Their Changes** | `git checkout --theirs <file>` | Accept the other person's version |
| **Keep Both** | Export both with `_COPY_<timestamp>` | Save both versions side by side |

## Error Message Guidelines

- ❌ `"HEAD is detached at 3fa2b1c"` → ✅ `"You're viewing an older version of this project"`
- ❌ `"Merge conflict in src/main.go"` → ✅ `"Some files have conflicting changes that need your attention"`
- ❌ `"Cannot fast-forward"` → ✅ `"Your project has changes that need to be synced"`
- ❌ `"fatal: not a git repository"` → ✅ `"This folder isn't set up as a project yet. Would you like to create one?"`

## Implementation Checklist

When adding any user-facing text:
- [ ] Does it avoid Git jargon?
- [ ] Would a PLC engineer understand it without Git training?
- [ ] Does it match the terminology in this table?
- [ ] Does the error message explain what happened AND what to do next?

---

See also: [Product Overview](Product%20Overview.md), [Explorer Feature](../technical/frontend/features/Explorer%20Feature.md)
