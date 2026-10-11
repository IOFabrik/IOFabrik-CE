# Frontend Architecture

> React 18 + TypeScript + Vite. Everything in `frontend/src/`.

## Directory Structure

The frontend follows a **feature-sliced** architecture with clear ownership boundaries:

```
frontend/src/
├── app/               # Application bootstrap
│   ├── App.tsx        # Root component (AuthGate → Login or Main App)
│   ├── main.tsx       # Entry point (PostHog, viewer registration)
│   ├── bootstrap/     # Startup logic
│   └── providers/     # Provider wrappers (Auth, Repo, Analytics)
│
├── domain/            # Business logic (non-UI)
│   ├── analytics/     # PostHog tracking helpers
│   ├── auth/          # Supabase auth context & services
│   └── repo/          # Git state machine (RepoContext, queries, commands)
│
├── features/          # User-facing feature modules
│   ├── auth/          # Login view, GitHub device flow modal
│   ├── debug/         # Debug logging view & page
│   ├── explorer/      # File browser, commit flow, diff viewer
│   ├── history/       # Commit history, git graph
│   ├── merge/         # Merge workflow, conflict resolution
│   ├── profile/       # User profile view
│   ├── repo-settings/ # Per-repo settings
│   ├── settings/      # App settings (theme, git config, LFS)
│   └── welcome/       # Welcome screen, project creation, clone
│
├── shared/            # Cross-cutting reusables
│   ├── constants/     # VIEWS, ICON_SIZES, FILE_STATUS, etc.
│   ├── hooks/         # useWindowSize, useLoginTheme, useAnalytics
│   ├── icons/         # Custom icons (GitLab)
│   ├── runtime/       # Browser utils, Wails event helpers
│   ├── ui/            # shadcn-style Radix primitives
│   └── utils/         # gitHelpers, path utils, misc
│
├── viewers/           # Pluggable file/diff viewer system
│   ├── registry/      # Viewer routing (registry, builtins, cache)
│   └── components/    # Viewer components (file/, diff/, shared/)
│
├── widgets/           # Higher-level layout components
│   └── layout/        # VS Code-like shell (AppLayout, TopBar, etc.)
│
└── context/           # Context facade barrel (re-exports)
```

## Feature Module Convention

Each feature follows a consistent structure:

```
features/<feature>/
├── README.md          # Feature overview
├── components/        # UI components
│   └── README.md
├── hooks/             # Feature-specific hooks
│   └── README.md
├── pages/             # Main area pages
│   ├── index.ts       # Page exports
│   └── README.md
└── panels/            # Optional sidebar panels
    └── README.md
```

## Component Categories

| Category | Location | Purpose |
|----------|----------|---------|
| **Pages** | `features/<feature>/pages/` | Main area content (rendered by view registry) |
| **Views** | `features/<feature>/components/` | Sidebar view content |
| **Modals** | `features/<feature>/components/` or `widgets/layout/` | Dialog overlays |
| **UI Primitives** | `shared/ui/` | Radix-based headless components with Tailwind styles |
| **Layout Widgets** | `widgets/layout/` | App shell components (TopBar, Sidebar, etc.) |
| **Viewers** | `viewers/components/` | File and diff viewers |

## Styling

**Primary:** Tailwind CSS v4 — utility-first classes everywhere.

Theme tokens defined in `index.css`:
```css
:root {
    --color-theme-base: #0a0a0a;
    --color-theme-primary: #e0e0e0;
    --color-theme-muted: #888888;
    --color-theme-surface: #1e1e1e;
}
```

**Usage patterns:**
```tsx
// Theme-aware classes
className="bg-theme-base text-theme-primary"

// Standard Tailwind
className="bg-gray-800/50 text-gray-400 hover:bg-gray-700/50"

// Component variants (cva)
const buttonVariants = cva("inline-flex items-center ...", {
    variants: { size: { sm: "h-8 px-3", md: "h-10 px-4" } }
});
```

**Radix UI** — Headless primitives (no built-in styling):
- Dialog, AlertDialog, DropdownMenu, ContextMenu, Popover
- Select, Switch, Tooltip, Progress

**Icons** — `lucide-react` exclusively:
```tsx
import { FolderOpen } from 'lucide-react';
<FolderOpen size={ICON_SIZES.md} />  // 20px

// Size constants: xs=14, sm=16, md=20, lg=28
```

## Wails Bindings

Auto-generated TypeScript bindings live in `frontend/bindings/iofabrik/services/`. **Never edit these manually.**

Import pattern:
```tsx
import { CommitAll } from '../../bindings/iofabrik/services/gitservice';
import type { OperationResult } from '../../bindings/iofabrik/services/models';
```

Regenerate after Go changes:
```bash
task common:generate:bindings
```

## Performance Patterns

| Pattern | When to Use | Example |
|---------|-------------|---------|
| `React.memo()` | Components receiving stable props | `export default memo(FileListItem)` |
| `useCallback` | Event handlers passed as props | `const handleClick = useCallback(...)` |
| `useMemo` | Derived/computed state | `const sortedFiles = useMemo(...)` |
| `@tanstack/react-virtual` | Lists > 100 items | CommitList, file lists |
| `React.lazy()` | Heavy components (viewers) | PDF viewer, 3D viewer |

## Notification System

Uses `sonner` for toast notifications:
```tsx
import { toast } from 'sonner';
toast.success("Changes saved");
toast.error("Failed to sync: " + error);
toast.info("New updates available");
```

---

**Next:** [Layout System](Layout%20System.md) | [Context Providers](Context%20Providers.md) | [UI Components](UI%20Components.md) | [Viewer System](Viewer%20System.md)
