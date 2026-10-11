# State Management

> How application state flows through contexts, events, and the Wails bridge.

## Three-Layer Sync Strategy

IOFabrik uses three mechanisms to keep the frontend in sync with the git repository:

```
Priority 1: Event-Driven (Primary)
  FileWatcherService detects changes → emits "file-changes"
  → RepoContext refreshes git status immediately

Priority 2: Post-Operation Refresh
  After every git operation (commit, push, merge, etc.)
  → RepoContext manually calls refreshAll()

Priority 3: Polling (Fallback)
  Every 30 seconds, RepoContext polls git status
  → Catches anything events might miss
```

## Context Architecture

```
App.tsx
└── AuthProvider (AuthContext)        ← Supabase session
    └── AnalyticsProvider             ← PostHog wrapper
        └── AuthGate                  ← Routes: Login or Main App
            └── RepoProvider (RepoContext)  ← Git state machine
                └── LayoutProvider (LayoutContext) ← UI state
                    └── AppLayout     ← VS Code-like shell
```

### RepoContext — Git State Machine

> `frontend/src/domain/repo/context/RepoContext.tsx` — ~3,052 lines

The largest context. Manages the complete git state:

**State includes:**
- `repoPath` — Current repo path
- `repoStatus` — Working tree status (files, staged, unstaged)
- `currentBranch` — Active branch name
- `branches` — All local and remote branches
- `commits` — Commit history
- `stashes` — Stash list
- `mergeState` — Active merge/conflict state
- `stuckState` — Detected stuck states (merge, cherry-pick, revert, etc.)
- `lfsStatus` — LFS file tracking info
- `githubStatus` — GitHub auth and repo info
- `isLoading` — Various loading states
- `error` — Current error state

**Key actions:**
- `refreshAll()` — Full state refresh (calls multiple backend methods)
- `refreshStatus()` — Quick status-only refresh
- `commitAll(message)` — Save changes
- `sync()` — Pull + push with progress
- `push()` — Push with progress
- `createBranch(name)` — Create and switch to new branch
- `switchBranch(name)` — Switch branches
- `startMerge(source, options)` — Begin merge
- `resolveConflict(file, strategy)` — Resolve merge conflict

**Dispatch pattern:**
```tsx
const [state, dispatch] = useReducer(repoReducer, initialState);
// dispatch({ type: 'REPO_LOADED', payload: {...} })
// dispatch({ type: 'STATUS_UPDATED', payload: {...} })
```

### LayoutContext — UI State

> `frontend/src/context/LayoutContext.tsx` — ~365 lines

Controls all non-git UI state:

- `activeView` — Which sidebar view is shown (explorer, history, merge, settings, etc.)
- `sidebarCollapsed` / `sidebarWidth` — Sidebar layout
- `explorerTabs` — Open file viewer tabs
- `activeExplorerTab` — Currently focused tab
- `theme` — light / dark / system
- `selectedSettingsCategory` — Active settings panel
- `selectedWelcomeCategory` — Active welcome sub-page

**Responsive auto-collapse:**
```tsx
// Auto-collapse sidebar on narrow windows
useWindowSize() → if width < threshold → setSidebarCollapsed(true)
// But respects manual toggle (user intent tracking)
```

### AuthContext — Supabase Session

> `frontend/src/domain/auth/context/AuthContext.tsx` — ~188 lines

Manages Supabase authentication:

- `isAuthenticated` — Whether user is logged in
- `isLoading` — Session hydration in progress
- `userEmail` / `userName` — Current user info
- `loginWithPassword(email, password)` — Sign in
- `logout()` — Sign out
- `refreshSession()` — Token refresh

**Session hydration flow:**
```
App mounts → useEffect calls hydrateFromKeychain()
  → AuthService.LoadSession() (OS keychain)
  → If valid: set session, call SaveSession() (refresh)
  → If invalid: ClearSession(), show login
```

## Data Flow

### Write Path (User Action → Backend → UI Update)

```
User clicks "Save Changes"
  → RepoContext.commitAll(message)
    → CommitAll binding → Go GitService.CommitAll()
      → CommandRunner.RunGit("add", ".") + RunGit("commit", "-m", msg)
      → Returns OperationResult{Success: true}
    → If success: dispatch({type: 'COMMIT_CREATED'})
    → refreshStatus() → GetStatus() binding → dispatch({type: 'STATUS_UPDATED'})
    → Toast notification ("Changes saved")
```

### Read Path (Filesystem → Event → UI Update)

```
External editor saves file
  → fsnotify fires event
  → FileWatcherService batches (300ms)
  → Emits "file-changes" event
  → RepoContext event listener fires
  → refreshStatus() → GetStatus() binding
  → dispatch({type: 'STATUS_UPDATED'})
  → UI re-renders with updated file list
```

## Performance Considerations

- **Memoization:** Components use `React.memo()`, handlers use `useCallback`, derived state uses `useMemo`
- **Virtualization:** Large lists (commit history, file lists) use `@tanstack/react-virtual`
- **Batched updates:** Multiple state changes batched via React 18's automatic batching
- **Debounced events:** FileWatcherService's 300ms debounce prevents UI thrashing

---

**Related:** [Event System](Event%20System.md) | [Context Providers](../frontend/Context%20Providers.md) | [Frontend Architecture](../frontend/Frontend%20Architecture.md)
