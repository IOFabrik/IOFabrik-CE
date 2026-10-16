# Explorer Feature

> `features/explorer/` — The primary working screen for daily git operations.

## Overview

The Explorer is the main feature users interact with. It shows the file browser, changed files, and drives the commit/push/sync workflow. The Explorer's main area changes based on the current git state.

## Components

### Sidebar
- **ExplorerView** — Sidebar entry point, shows status panel
- **ExplorerStatusPanel** — Changed files list, staging controls, quick actions
- **SidebarCommitPanel** — Commit message input, "Save Changes" button

### Main Area Pages (Sub-Screens)

The Explorer page shows different screens based on the repo state:

| Screen | Condition | Purpose |
|--------|-----------|---------|
| `AllSyncedScreen` | No pending changes, pushed up to date | "Everything is saved and shared" |
| `CommitScreen` | Has uncommitted changes | "Save Changes" flow — commit message + save |
| `ReadyToPushScreen` | Commits exist that aren't pushed | "Share" flow — push to remote |
| `MergeRequestScreen` | Active merge in progress | Merge conflict resolution |

State-based routing in `ExplorerPage.tsx`:
```tsx
if (mergeState) return <MergeRequestScreen />;
if (hasUnpushedCommits) return <ReadyToPushScreen />;
if (hasChanges) return <CommitScreen />;
return <AllSyncedScreen />;
```

### File Browser
- **SimpleFileBrowser** — Grid and virtualized list layouts of repo files
  - Double-click opens a file in its default application or navigates into a folder
  - Right-click context menu (open, preview, generate preview, copy path, reveal in Finder/Explorer)
  - File status indicators (green=added, yellow=modified, red=deleted)

**Generate preview** appears for every file in both layouts. Each menu opening checks the file's basename: a nonempty name followed by exactly one dot and `ACD`, without regard to letter case. For example, `Controller.AcD` is eligible; `Controller.BAK042.ACD`, `Controller.acd.something`, and `.ACD` are disabled. Dots in parent directories and Git tracking or ignore status do not change this result.

This is a Phase 1 placeholder. Selecting an eligible file's action only shows “Preview generation is not available yet.” It does not start an SDK process, create files, or open a viewer. Working generation and installed Windows release verification are separate work.

### Modals
- **LFSAutoTrackModal** — Intercepts commit flow when large files detected (see below)
- **MainBranchSaveChoiceModal** — Save choices on the effective project default
- **ProjectSetupBanner** — Banner for repos needing initial setup

## Default branch and Save

Save prompts, Explorer actions, and Save analytics compare the active branch's
exact name with the shared project default from `RepoContext`. A selected
`release/2026` receives the default-branch Save choices; an unrelated `main` or
`master` follows the work-branch path. A remembered Save choice belongs to one
project and its effective default, and is cleared when that default changes.

Every Save entry validates the default locally before the Save flow proceeds.
If it is unavailable, the shared default-branch chooser asks the user to select
and confirm a branch. Confirmation resumes one requested Save; cancellation
keeps the unsaved files and message. A usable stored automatic or manual
selection supports offline Save without another GitHub lookup. The branch
explicitly recorded by local initialization supports the first Save.
The first Save stays on that initial branch so there is a saved snapshot before
the user creates a work branch.

The backend revalidates before staging and committing, including direct service
calls. Save records changes on the active branch. An unknown or detached current
branch never becomes `main` in the UI; saving while detached asks the user to
switch to or create a branch first.

## LFS Auto-Track Flow

The `useLfsAutoTrackBeforeSave` hook intercepts the commit flow:

```
User clicks "Save Changes"
  → Hook calls LFSService.DetectLargeFiles()
  → If large untracked files found:
    → Show LFSAutoTrackModal
    → User selects which patterns to track
    → Apply tracking patterns
    → Proceed with commit
  → If no large files: proceed immediately
```

## Explorer Tab System

Files opened from the file browser appear as tabs in the main area:

- **Files tab** (pinned, always visible) — Shows SimpleFileBrowser
- **File viewer tabs** — One per opened file, uses [Viewer System](../Viewer%20System.md) to render
- Tabs dedup by file path (opening same file focuses existing tab)
- Close button on each tab

---

**Related:** [Layout System](../Layout%20System.md) | [RepoContext](../Context%20Providers.md#repocontext) | [Viewer System](../Viewer%20System.md) | [GitService](../../backend/services/GitService.md)
